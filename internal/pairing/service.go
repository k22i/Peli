package pairing

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"rsc.io/qr"

	"github.com/k22i/Peli/internal/tracking"
)

// The Wails service behind Settings › Integrations' "Add to another
// device" and "Copy from another device" (ADR-0061). The camera always
// scans: a phone or tablet scans, a Mac shows a code (and, to another Mac,
// a phrase).
//
//	Mac → iPhone:  Mac StartSending + WaitSent;     iPhone ReceiveFrom + Confirm
//	iPhone → Mac:  Mac StartReceiving + WaitReceived + Confirm; iPhone SendTo
//	Mac → Mac:     Mac StartSending (phrase);        Mac ReceivePhrase + Confirm
//	iPhone → iPad: iPhone StartSending + WaitSent;  iPad ReceiveFrom + Confirm

var (
	// ErrWrongWay means the scanned code is for the other direction: a
	// "Copy from" code scanned to copy, or the reverse.
	ErrWrongWay = errors.New("pairing: that code is for the other direction")
	// ErrNothingHeld means Confirm came with nothing received to keep.
	ErrNothingHeld = errors.New("pairing: nothing received to keep")
)

// Service is the bound pairing API. One code is shown at a time.
type Service struct {
	src Sources

	mu     sync.Mutex
	shower *shower
	sent   *Bundle // what the shower offers, to mark shared once sent
	held   *Bundle // what was received, until Confirm or Cancel
	used   map[[16]byte]bool
}

// NewService returns the service over src.
func NewService(src Sources) *Service {
	return &Service{src: src, used: map[[16]byte]bool{}}
}

// ServiceShutdown stops any code being shown.
func (s *Service) ServiceShutdown() error {
	s.Cancel()
	return nil
}

// PairCode is a code to show: the QR code as an SVG path in a Size × Size
// grid, and for a Mac sending to another Mac, the phrase.
type PairCode struct {
	Size      int       `json:"size"`
	Path      string    `json:"path"`
	Phrase    string    `json:"phrase"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Offer lists what this device could send.
func (s *Service) Offer() (Offer, error) { return MakeOffer(s.src) }

// PhraseAvailable reports whether this device can show or type a phrase
// (a Mac).
func (s *Service) PhraseAvailable() bool { return PhraseAvailable }

func (s *Service) ownAccount() ([16]byte, error) {
	account, err := s.src.account()
	if err != nil {
		return [16]byte{}, err
	}
	return AccountHash(account), nil
}

// StartSending builds the bundle for choice and shows a code for another
// device to scan (and a phrase, on a Mac) for 3 minutes. label is the
// frontend's name for this device ("iPhone", "iPad", "computer").
func (s *Service) StartSending(ctx context.Context, choice Choice, label string) (PairCode, error) {
	account, err := s.ownAccount()
	if err != nil {
		return PairCode{}, err
	}
	bundle, err := Build(ctx, s.src, choice, thisDevice(label))
	if err != nil {
		return PairCode{}, err
	}
	return s.show(ModeOffer, account, thisDevice(label), &bundle)
}

// StartReceiving shows a code for a phone or tablet to scan and send to
// (a Mac receiving, ADR-0061).
func (s *Service) StartReceiving(label string) (PairCode, error) {
	account, err := s.ownAccount()
	if err != nil {
		return PairCode{}, err
	}
	return s.show(ModeRequest, account, thisDevice(label), nil)
}

func (s *Service) show(mode Mode, account [16]byte, device Device, bundle *Bundle) (PairCode, error) {
	s.Cancel()
	sh, err := newShower(mode, account, device, bundle, mode == ModeOffer && PhraseAvailable, s.src.now())
	if err != nil {
		return PairCode{}, err
	}
	code, err := qr.Encode(sh.code().String(), qr.M)
	if err != nil {
		sh.end(outcome{err: ErrCancelled})
		return PairCode{}, err
	}
	s.mu.Lock()
	s.shower, s.sent = sh, bundle
	s.mu.Unlock()
	pc := PairCode{Size: code.Size, Path: qrPath(code), ExpiresAt: sh.expires}
	if sh.phrase != nil {
		pc.Phrase = sh.phrase.String()
	}
	return pc, nil
}

func (s *Service) current() (*shower, *Bundle) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shower, s.sent
}

// WaitSent waits for the code StartSending showed to be used, and returns
// the device that received it.
func (s *Service) WaitSent(ctx context.Context) (Device, error) {
	sh, bundle := s.current()
	if sh == nil || sh.mode != ModeOffer {
		return Device{}, ErrCancelled
	}
	o := sh.wait(ctx)
	if o.err != nil {
		return Device{}, o.err
	}
	if bundle != nil {
		MarkSent(s.src, *bundle, o.peer.Name)
	}
	return o.peer, nil
}

// WaitReceived waits for a phone or tablet to send to the code
// StartReceiving showed, and returns what it sent, matched to this
// device's profiles, for the user to confirm.
func (s *Service) WaitReceived(ctx context.Context) (Summary, error) {
	sh, _ := s.current()
	if sh == nil || sh.mode != ModeRequest {
		return Summary{}, ErrCancelled
	}
	o := sh.wait(ctx)
	if o.err != nil {
		return Summary{}, o.err
	}
	return s.hold(sh.id, *o.bundle)
}

// SendTo sends choice to the Mac whose "Copy from another device" code was
// scanned, and returns that Mac.
func (s *Service) SendTo(ctx context.Context, scanned string, choice Choice, label string) (Device, error) {
	c, err := s.checkCode(scanned, ModeRequest)
	if err != nil {
		return Device{}, err
	}
	account, err := s.ownAccount()
	if err != nil {
		return Device{}, err
	}
	device := thisDevice(label)
	bundle, err := Build(ctx, s.src, choice, device)
	if err != nil {
		return Device{}, err
	}
	// This device's own account, which the Mac checks against its own.
	ans, err := exchange(ctx, peerOf(c), request{Device: device, Account: hex.EncodeToString(account[:]), Bundle: &bundle})
	if err != nil {
		return Device{}, err
	}
	s.markUsed(c.Session)
	MarkSent(s.src, bundle, ans.Device.Name)
	return ans.Device, nil
}

// ReceiveFrom fetches what the scanned "Add to another device" code
// offers, and returns it matched to this device's profiles.
func (s *Service) ReceiveFrom(ctx context.Context, scanned string, label string) (Summary, error) {
	c, err := s.checkCode(scanned, ModeOffer)
	if err != nil {
		return Summary{}, err
	}
	return s.receive(ctx, peerOf(c), label)
}

// ReceivePhrase finds the Mac showing phrase on this network and fetches
// what it offers (Mac to Mac).
func (s *Service) ReceivePhrase(ctx context.Context, phrase string, label string) (Summary, error) {
	p, err := ParsePhrase(phrase)
	if err != nil {
		return Summary{}, err
	}
	account, err := s.ownAccount()
	if err != nil {
		return Summary{}, err
	}
	pr, err := phrasePeer(ctx, p)
	if err != nil {
		return Summary{}, err
	}
	if pr.account != account {
		return Summary{}, ErrWrongAccount
	}
	return s.receive(ctx, pr, label)
}

func (s *Service) receive(ctx context.Context, p peer, label string) (Summary, error) {
	account, err := s.ownAccount()
	if err != nil {
		return Summary{}, err
	}
	// This device's own account, which the sender checks against its own.
	ans, err := exchange(ctx, p, request{Device: thisDevice(label), Account: hex.EncodeToString(account[:])})
	if err != nil {
		return Summary{}, err
	}
	if ans.Bundle == nil {
		return Summary{}, ErrBadBundle
	}
	if err := ans.Bundle.Check(); err != nil {
		return Summary{}, err
	}
	return s.hold(p.session, *ans.Bundle)
}

// checkCode reads a scanned code for want, refusing one for the other way,
// an expired or used one, and another account's.
func (s *Service) checkCode(scanned string, want Mode) (Code, error) {
	c, err := ParseCode(scanned)
	if err != nil {
		return Code{}, err
	}
	if c.Mode != want {
		return Code{}, ErrWrongWay
	}
	if !s.src.now().Before(c.Expires) {
		return Code{}, ErrExpired
	}
	s.mu.Lock()
	used := s.used[c.Session]
	s.mu.Unlock()
	if used {
		return Code{}, ErrUsed
	}
	account, err := s.ownAccount()
	if err != nil {
		return Code{}, err
	}
	if c.Account != account {
		return Code{}, ErrWrongAccount
	}
	return c, nil
}

func (s *Service) markUsed(session [16]byte) {
	s.mu.Lock()
	s.used[session] = true
	s.mu.Unlock()
}

// hold keeps b until Confirm, and matches it.
func (s *Service) hold(session [16]byte, b Bundle) (Summary, error) {
	summary, err := Match(s.src, b)
	if err != nil {
		return Summary{}, err
	}
	s.mu.Lock()
	s.used[session] = true
	s.held = &b
	s.mu.Unlock()
	return summary, nil
}

// Confirm keeps what was received as the user chose on the summary.
func (s *Service) Confirm(d Decisions) (Applied, error) {
	s.mu.Lock()
	b := s.held
	s.held = nil
	s.mu.Unlock()
	if b == nil {
		return Applied{}, ErrNothingHeld
	}
	return Apply(s.src, *b, d)
}

// Cancel stops the code being shown and drops anything received but not
// kept.
func (s *Service) Cancel() {
	s.mu.Lock()
	sh := s.shower
	s.shower, s.sent, s.held = nil, nil, nil
	s.mu.Unlock()
	if sh != nil {
		sh.end(outcome{err: ErrCancelled})
	}
}

// --- this device ------------------------------------------------------------------

// thisDevice names this device to the other one: the Mac's computer name,
// or the frontend's "iPhone"/"iPad" (iOS gives apps no device name).
func thisDevice(label string) Device {
	platform := map[string]string{"darwin": "macos", "ios": "ios", "windows": "windows", "linux": "linux"}[runtime.GOOS]
	if runtime.GOOS == "ios" {
		if label != "iPad" {
			label = "iPhone"
		}
		return Device{Name: label, Platform: platform}
	}
	return Device{Name: computerName(), Platform: platform}
}

func computerName() string {
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("/usr/sbin/scutil", "--get", "ComputerName").Output(); err == nil {
			if name := strings.TrimSpace(string(out)); name != "" {
				return name
			}
		}
	}
	host, _ := os.Hostname()
	host, _, _ = strings.Cut(host, ".")
	if host == "" || host == "localhost" {
		return map[string]string{"darwin": "Mac", "windows": "Windows PC", "linux": "Linux PC"}[runtime.GOOS]
	}
	return host
}

// qrPath draws a QR code's dark modules as an SVG path (as the sign-in QR
// does, internal/account).
func qrPath(code *qr.Code) string {
	var b strings.Builder
	for y := range code.Size {
		for x := 0; x < code.Size; x++ {
			if !code.Black(x, y) {
				continue
			}
			run := 1
			for code.Black(x+run, y) {
				run++
			}
			fmt.Fprintf(&b, "M%d %dh%dv1h-%dz", x, y, run, run)
			x += run
		}
	}
	return b.String()
}

// --- errors for the frontend ---------------------------------------------------------

// MarshalError gives the frontend a code for the errors it explains.
func MarshalError(err error) []byte {
	var code string
	switch {
	case errors.Is(err, ErrWrongAccount):
		code = "wrong_account"
	case errors.Is(err, ErrNotSignedIn):
		code = "not_signed_in"
	case errors.Is(err, ErrExpired):
		code = "expired"
	case errors.Is(err, ErrUsed):
		code = "used"
	case errors.Is(err, ErrTooManyTries):
		code = "too_many_tries"
	case errors.Is(err, ErrRefused), errors.Is(err, ErrOpen):
		code = "refused"
	case errors.Is(err, ErrUnreachable) && LocalNetworkDenied(err) && runtime.GOOS == "ios":
		code = "local_network"
	case errors.Is(err, ErrUnreachable):
		code = "unreachable"
	case errors.Is(err, ErrNoNetwork):
		code = "no_network"
	case errors.Is(err, ErrNoSender):
		code = "no_sender"
	case errors.Is(err, ErrNothingToSend):
		code = "nothing_to_send"
	case errors.Is(err, ErrBadCode):
		code = "bad_code"
	case errors.Is(err, ErrBadPhrase):
		code = "bad_phrase"
	case errors.Is(err, ErrWrongWay):
		code = "wrong_way"
	case errors.Is(err, ErrBadBundle):
		code = "bad_bundle"
	case errors.Is(err, ErrCancelled):
		code = "cancelled"
	case errors.Is(err, ErrNothingHeld):
		code = "nothing_held"
	case errors.Is(err, tracking.ErrKidsProfile):
		code = "kids_profile"
	default:
		return nil
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
