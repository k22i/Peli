package pairing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/cpace"
)

// How long a code lasts, and how many wrong tries end it.
const (
	CodeLifetime = 3 * time.Minute
	maxBadTries  = 3
	maxBody      = 1 << 20
)

var (
	// ErrExpired means the code's 3 minutes are up.
	ErrExpired = errors.New("pairing: the code expired")
	// ErrUsed means the code was already used (it works once).
	ErrUsed = errors.New("pairing: the code was already used")
	// ErrRefused means the other device didn't accept the proof: a wrong
	// phrase, or a code from an earlier try.
	ErrRefused = errors.New("pairing: the other device refused the code")
	// ErrTooManyTries means three wrong tries ended the code.
	ErrTooManyTries = errors.New("pairing: too many wrong tries")
	// ErrCancelled means the user closed it.
	ErrCancelled = errors.New("pairing: cancelled")
)

// The wire messages, JSON inside the seal.
type request struct {
	Device  Device  `json:"device"`
	Account string  `json:"account"`
	Bundle  *Bundle `json:"bundle,omitempty"`
}

type answer struct {
	Device Device  `json:"device"`
	Bundle *Bundle `json:"bundle,omitempty"`
}

// errorBody is an unsealed refusal: {"code": "used"}.
type errorBody struct {
	Code string `json:"code"`
}

// outcome is how a shower's session ended.
type outcome struct {
	peer   Device
	bundle *Bundle // ModeRequest: what was pushed
	err    error
}

// shower is the side that shows the code and listens: single use, three
// bad tries, CodeLifetime.
type shower struct {
	mode    Mode
	id      [16]byte
	k       [32]byte
	keys    keyPair
	account [16]byte
	device  Device
	bundle  *Bundle // ModeOffer
	phrase  *Phrase // ModeOffer on a Mac: the typed path
	expires time.Time

	mu       sync.Mutex
	attempts map[[16]byte][]byte // phrase attempt → its K
	starts   int
	bad      int
	claimed  bool // a good request is being answered
	ended    bool
	result   outcome
	done     chan struct{}
	server   *http.Server
	stop     []func()
	port     uint16
	addrs    []netip.Addr
}

// newShower starts listening on this device's LAN addresses.
func newShower(mode Mode, account [16]byte, device Device, bundle *Bundle, withPhrase bool, now time.Time) (*shower, error) {
	s := &shower{mode: mode, account: account, device: device, bundle: bundle, expires: now.Add(CodeLifetime),
		attempts: map[[16]byte][]byte{}, done: make(chan struct{})}
	if _, err := io.ReadFull(rand.Reader, s.id[:]); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(rand.Reader, s.k[:]); err != nil {
		return nil, err
	}
	var err error
	if s.keys, err = newKeyPair(); err != nil {
		return nil, err
	}
	if withPhrase {
		p, err := NewPhrase()
		if err != nil {
			return nil, err
		}
		s.phrase = &p
	}
	listeners, err := listenLAN()
	if err != nil {
		return nil, err
	}
	s.port = uint16(listeners[0].Addr().(*net.TCPAddr).Port)
	for _, l := range listeners {
		ap, _ := netip.ParseAddrPort(l.Addr().String())
		s.addrs = append(s.addrs, ap.Addr().Unmap())
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /pair/{id}", s.handlePair)
	mux.HandleFunc("POST /phrase/start", s.handlePhrase)
	s.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second}
	for _, l := range listeners {
		go func() { _ = s.server.Serve(l) }()
	}
	if s.phrase != nil {
		if stop, err := advertise(s.phrase.Tag, s.port); err == nil {
			s.stop = append(s.stop, stop)
		} else {
			slog.Info("pairing: no Bonjour advert", "error", err)
		}
	}
	expiry := time.AfterFunc(s.expires.Sub(now), func() { s.end(outcome{err: ErrExpired}) })
	s.stop = append(s.stop, func() { expiry.Stop() })
	return s, nil
}

// code is what the QR code shows.
func (s *shower) code() Code {
	return Code{Mode: s.mode, Expires: s.expires, Session: s.id, Account: s.account, Key: s.k, Pub: s.keys.public, Port: s.port, Addrs: s.addrs}
}

// end stops the session once, with o as its outcome.
func (s *shower) end(o outcome) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended, s.result = true, o
	stops := s.stop
	s.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
	close(s.done)
	// Shutdown lets the answer that ended it finish writing.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.server.Shutdown(ctx)
	}()
}

// wait returns the session's outcome.
func (s *shower) wait(ctx context.Context) outcome {
	select {
	case <-ctx.Done():
		return outcome{err: ctx.Err()}
	case <-s.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.result
	}
}

// badTry counts a wrong try and ends the session at the third. Locked.
func (s *shower) badTryLocked() bool {
	s.bad++
	return s.bad >= maxBadTries
}

func refuse(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Code: code})
}

func (s *shower) handlePair(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		return
	}
	var id [16]byte
	raw, err := hex.DecodeString(r.PathValue("id"))
	ok := err == nil && len(raw) == 16
	copy(id[:], raw)

	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		refuse(w, http.StatusGone, endedCode(s.result.err))
		return
	}
	var k []byte
	if ok && id == s.id {
		k = s.k[:]
	} else if ok {
		k = s.attempts[id]
	}
	var rpub [32]byte
	if len(body) >= 64 {
		copy(rpub[:], body[:32])
	}
	if k == nil || len(body) < 64 || !proofOK(k, id, rpub, body[32:64]) {
		over := s.badTryLocked()
		s.mu.Unlock()
		refuse(w, http.StatusUnauthorized, "refused")
		if over {
			s.end(outcome{err: ErrTooManyTries})
		}
		return
	}
	s.mu.Unlock()

	key, err := sealKey(k, s.keys.private, rpub, id)
	if err != nil {
		refuse(w, http.StatusBadRequest, "refused")
		return
	}
	t := transcript{mode: s.mode, session: id, account: s.account, s: s.keys.public, r: rpub}
	plain, err := open(key, t.aad(dirRequest), body[64:])
	var req request
	if err == nil {
		err = json.Unmarshal(plain, &req)
	}
	if err != nil {
		s.mu.Lock()
		over := s.badTryLocked()
		s.mu.Unlock()
		refuse(w, http.StatusUnauthorized, "refused")
		if over {
			s.end(outcome{err: ErrTooManyTries})
		}
		return
	}
	if req.Account != hex.EncodeToString(s.account[:]) {
		refuse(w, http.StatusForbidden, "wrong_account")
		s.end(outcome{err: ErrWrongAccount})
		return
	}
	ans := answer{Device: s.device}
	switch s.mode {
	case ModeOffer:
		ans.Bundle = s.bundle
	case ModeRequest:
		if req.Bundle == nil || req.Bundle.Check() != nil {
			refuse(w, http.StatusBadRequest, "bad_bundle")
			s.end(outcome{err: ErrBadBundle})
			return
		}
	}
	plainAns, err := json.Marshal(ans)
	if err == nil {
		plainAns, err = seal(key, t.aad(dirAnswer), plainAns)
	}
	if err != nil {
		refuse(w, http.StatusInternalServerError, "refused")
		return
	}
	// One good transfer ends it: claim it before answering, so a second
	// request in flight gets "used".
	s.mu.Lock()
	if s.ended || s.claimed {
		s.mu.Unlock()
		refuse(w, http.StatusGone, "used")
		return
	}
	s.claimed = true
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(plainAns)))
	_, _ = w.Write(plainAns)
	s.end(outcome{peer: req.Device, bundle: req.Bundle})
}

func endedCode(err error) string {
	switch {
	case errors.Is(err, ErrExpired):
		return "expired"
	case errors.Is(err, ErrTooManyTries):
		return "too_many_tries"
	default:
		return "used"
	}
}

// phraseContext is CPace's context for the phrase with tag.
func phraseContext(tag int) *cpace.ContextInfo {
	return cpace.NewContextInfo("peli-pair receiver", "peli-pair sender", []byte("peli-pair v1 phrase "+strconv.Itoa(tag)))
}

// phraseKey turns CPace's output into a K for the proof and seal.
func phraseKey(cpaceKey []byte) []byte { return derive(cpaceKey, nil, "peli-pair v1 phrase key") }

// handlePhrase is CPace's first round: msgA in, attempt ‖ S ‖ account ‖ msgB
// out. Each start is a guess; three end the session.
func (s *shower) handlePhrase(w http.ResponseWriter, r *http.Request) {
	msgA, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		return
	}
	s.mu.Lock()
	if s.ended || s.phrase == nil {
		ended := s.ended
		s.mu.Unlock()
		if ended {
			refuse(w, http.StatusGone, endedCode(s.result.err))
		} else {
			refuse(w, http.StatusNotFound, "no_phrase")
		}
		return
	}
	s.starts++
	if s.starts > maxBadTries {
		s.mu.Unlock()
		refuse(w, http.StatusGone, "too_many_tries")
		s.end(outcome{err: ErrTooManyTries})
		return
	}
	secret, tag := s.phrase.Secret, s.phrase.Tag
	s.mu.Unlock()

	msgB, key, err := cpace.Exchange(secret, phraseContext(tag), msgA)
	if err != nil {
		refuse(w, http.StatusBadRequest, "refused")
		return
	}
	var attempt [16]byte
	if _, err := io.ReadFull(rand.Reader, attempt[:]); err != nil {
		refuse(w, http.StatusInternalServerError, "refused")
		return
	}
	s.mu.Lock()
	s.attempts[attempt] = phraseKey(key)
	s.mu.Unlock()
	out := append(append(append(attempt[:], s.keys.public[:]...), s.account[:]...), msgB...)
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(out)
}

// --- addresses ------------------------------------------------------------------

// Interfaces never listened on: cellular (pdp_ip), VPN tunnels, AirDrop's
// and the low-latency WLAN.
var skipInterfaces = []string{"pdp_ip", "utun", "ipsec", "awdl", "llw", "ap1"}

// lanAddrs are this device's private (RFC 1918, ULA) addresses on up,
// non-loopback interfaces that aren't cellular or a tunnel. IPv6 link-local
// addresses need a zone the QR code can't carry, so they're left out.
func lanAddrs() []netip.Addr {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var v4, v6 []netip.Addr
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || skipped(iface.Name) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			prefix, err := netip.ParsePrefix(a.String())
			if err != nil {
				continue
			}
			ip := prefix.Addr().Unmap()
			if !ip.IsPrivate() {
				continue
			}
			if ip.Is4() {
				v4 = append(v4, ip)
			} else {
				v6 = append(v6, ip)
			}
		}
	}
	return append(v4, v6...)[:min(len(v4)+len(v6), maxAddrs)]
}

func skipped(name string) bool {
	for _, p := range skipInterfaces {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// ErrNoNetwork means this device has no local network to pair on.
var ErrNoNetwork = errors.New("pairing: not on a local network")

// listenLAN listens on one port on each LAN address, never on 0.0.0.0.
func listenLAN() ([]net.Listener, error) {
	addrs := lanAddrs()
	if len(addrs) == 0 {
		return nil, ErrNoNetwork
	}
	first, err := net.Listen("tcp", netip.AddrPortFrom(addrs[0], 0).String())
	if err != nil {
		return nil, fmt.Errorf("pairing: listen: %w", err)
	}
	port := uint16(first.Addr().(*net.TCPAddr).Port)
	listeners := []net.Listener{first}
	for _, a := range addrs[1:] {
		if l, err := net.Listen("tcp", netip.AddrPortFrom(a, port).String()); err == nil {
			listeners = append(listeners, l)
		}
	}
	return listeners, nil
}
