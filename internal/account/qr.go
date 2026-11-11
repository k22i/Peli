package account

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"rsc.io/qr"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/store"
)

// QR sign-in (#21, ADR-0013): Peli shows a QR code and a short code, and the
// user approves it on their phone, signed in to Nuvio at nuvio.tv/link or in
// the Nuvio app. The device code and nonce stay in Go.

// After a failed poll, the next waits twice as long, up to this.
const qrRetryMax = 30 * time.Second

// QRCode is a pending QR sign-in, for the sign-in screen to show.
type QRCode struct {
	// What the QR code opens: the link page with the code filled in.
	URL string `json:"url"`
	// The short code to type at LinkURL instead.
	Code      string    `json:"code"`
	LinkURL   string    `json:"linkUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
	// The QR code's dark modules as an SVG path, in a Size × Size grid with
	// no quiet zone.
	Size int    `json:"size"`
	Path string `json:"path"`
}

// qrSignIn is the pending QR sign-in. Its lock lets one wait poll at a time.
type qrSignIn struct {
	login nuvio.DeviceLogin

	mu       sync.Mutex
	signedIn *store.Profile
}

// StartQRSignIn starts a QR sign-in, replacing any before it. WaitQRSignIn
// then waits for the user to approve it.
func (s *Service) StartQRSignIn(ctx context.Context) (QRCode, error) {
	// The link page and the Nuvio app approve sign-ins to Nuvio's backend
	// only.
	if s.customServer() {
		return QRCode{}, ErrQRUnavailable
	}
	// Check first, so the user isn't asked to approve a sign-in Peli can't
	// keep.
	if err := s.session.keychain.Available(); err != nil {
		return QRCode{}, err
	}
	login, err := s.nuvio.StartDeviceLogin(ctx, s.linkURL, s.deviceName)
	if err != nil {
		return QRCode{}, err
	}
	code, err := qr.Encode(login.URL, qr.M)
	if err != nil {
		return QRCode{}, err
	}
	s.qrMu.Lock()
	s.qr = &qrSignIn{login: login}
	s.qrMu.Unlock()
	return QRCode{
		URL: login.URL, Code: login.UserCode, LinkURL: login.LinkURL, ExpiresAt: login.ExpiresAt,
		Size: code.Size, Path: qrPath(code),
	}, nil
}

// qrPath draws a QR code's dark modules as an SVG path, one rectangle per run
// of dark modules in a row.
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

// WaitQRSignIn waits until the QR sign-in with code is approved, then signs
// in as SignIn does and returns the profile that is now current. It polls
// at the backend's interval, backing off while the backend can't be
// reached. It fails with nuvio.ErrDeviceLoginExpired when the code expires
// or a newer one replaced it, and stops when ctx is cancelled (the frontend
// cancels the call when it leaves the screen).
func (s *Service) WaitQRSignIn(ctx context.Context, code string) (store.Profile, error) {
	s.qrMu.Lock()
	pending := s.qr
	s.qrMu.Unlock()
	if pending == nil || pending.login.UserCode != code {
		return store.Profile{}, nuvio.ErrDeviceLoginExpired
	}
	// A second wait for the same code (the screen mounted twice) waits its
	// turn, and gets the first one's result.
	pending.mu.Lock()
	defer pending.mu.Unlock()
	if pending.signedIn != nil {
		return *pending.signedIn, nil
	}

	interval, failures := pending.login.PollInterval, 0
	for {
		wait := interval
		if failures > 0 {
			wait = min(interval<<failures, qrRetryMax)
		}
		if err := s.sleep(ctx, wait); err != nil {
			return store.Profile{}, err
		}
		status, next, err := s.nuvio.PollDeviceLogin(ctx, pending.login)
		if errors.Is(err, nuvio.ErrUnreachable) || errors.Is(err, nuvio.ErrUnavailable) || errors.Is(err, nuvio.ErrRateLimited) {
			// Offline past the code's expiry: it's no use any more, and the
			// error says why the screen never heard.
			if s.session.now().After(pending.login.ExpiresAt) {
				return store.Profile{}, err
			}
			failures++
			continue
		}
		if err != nil {
			return store.Profile{}, err
		}
		interval, failures = next, 0
		if status == nuvio.DeviceLoginPending {
			continue
		}
		if status != nuvio.DeviceLoginApproved {
			// Expired, or exchanged by a wait before this one that failed
			// after the exchange.
			return store.Profile{}, fmt.Errorf("%w: %s", nuvio.ErrDeviceLoginExpired, status)
		}
		break
	}

	profile, err := s.signIn(ctx, func(ctx context.Context) (nuvio.Session, error) {
		return s.nuvio.ExchangeDeviceLogin(ctx, pending.login)
	})
	if err != nil {
		return store.Profile{}, err
	}
	pending.signedIn = &profile
	return profile, nil
}

// deviceName is what the phone shows when it approves a QR sign-in:
// "Peli on" and the computer's name, or its OS.
func deviceName() string {
	host, _ := os.Hostname()
	// macOS adds .local, and some networks a domain.
	host, _, _ = strings.Cut(host, ".")
	if host == "" || host == "localhost" {
		host = map[string]string{"darwin": "macOS", "windows": "Windows", "linux": "Linux"}[runtime.GOOS]
	}
	if host == "" {
		return "Peli"
	}
	return "Peli on " + host
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
