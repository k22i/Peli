package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"rsc.io/qr"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/secrets"
)

// phoneApproves makes the fixture's waits instant, and has the phone approve
// the pending QR sign-in as email during the wait numbered at (from 1). It
// returns the waits so far.
func phoneApproves(t *testing.T, f fixture, at int, email string) func() []time.Duration {
	t.Helper()
	var waits []time.Duration
	f.service.sleep = func(ctx context.Context, d time.Duration) error {
		waits = append(waits, d)
		if len(waits) == at {
			codes := f.backend.UserCodes()
			if len(codes) == 0 || !f.backend.Approve(codes[len(codes)-1], email) {
				t.Error("no QR sign-in to approve")
			}
		}
		return ctx.Err()
	}
	return func() []time.Duration { return waits }
}

func TestQRSignIn(t *testing.T) {
	f := newFixture(t)
	f.service.deviceName = "Peli on test-mac"
	waits := phoneApproves(t, f, 3, "me@example.com")

	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if code.Code == "" || code.URL != nuvio.DefaultLinkURL+"?code="+code.Code || code.LinkURL != nuvio.DefaultLinkURL {
		t.Fatalf("code = %+v", code)
	}
	if left := time.Until(code.ExpiresAt); left < 4*time.Minute || left > 5*time.Minute {
		t.Fatalf("expires in %v", left)
	}
	if name := f.backend.Body("/rest/v1/rpc/start_device_login_session")["p_device_name"]; name != "Peli on test-mac" {
		t.Fatalf("device name = %v", name)
	}
	// The frontend gets no token, nonce or device code.
	data, _ := json.Marshal(code)
	if strings.Contains(string(data), "device-") || strings.Contains(string(data), "nonce") {
		t.Fatalf("QR code JSON = %s", data)
	}

	current, err := f.service.WaitQRSignIn(t.Context(), code.Code)
	if err != nil {
		t.Fatal(err)
	}
	if current.Name != "Kevin" || current.NuvioIndex == nil || *current.NuvioIndex != 1 {
		t.Fatalf("current = %+v", current)
	}
	if got := waits(); !slices.Equal(got, []time.Duration{3 * time.Second, 3 * time.Second, 3 * time.Second}) {
		t.Fatalf("waits = %v, want the backend's 3 s three times", got)
	}
	access, refresh := f.backend.Tokens()
	if f.keychain.items[KeyAccessToken] != access || f.keychain.items[KeyRefreshToken] != refresh {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
	if st, err := f.service.Status(); err != nil || !st.SignedIn {
		t.Fatalf("status = %+v, %v", st, err)
	}
	if profiles, _ := f.store.Profiles(); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}

	// A second wait for the same code (the screen mounted twice) gets the
	// same profile without exchanging again.
	again, err := f.service.WaitQRSignIn(t.Context(), code.Code)
	if err != nil || again != current {
		t.Fatalf("second wait = %+v, %v", again, err)
	}
}

func TestQRSignInExpires(t *testing.T) {
	f := newFixture(t)
	f.service.sleep = func(context.Context, time.Duration) error {
		f.backend.ExpireDeviceLogins()
		return nil
	}
	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.service.WaitQRSignIn(t.Context(), code.Code)
	if !errors.Is(err, nuvio.ErrDeviceLoginExpired) {
		t.Fatalf("err = %v, want ErrDeviceLoginExpired", err)
	}
	if got := string(MarshalError(err)); got != `{"code":"qr_expired"}` {
		t.Fatalf("MarshalError = %s", got)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
}

func TestQRSignInReplaced(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if first.Code == second.Code {
		t.Fatal("a new code is the same as the old one")
	}
	if _, err := f.service.WaitQRSignIn(t.Context(), first.Code); !errors.Is(err, nuvio.ErrDeviceLoginExpired) {
		t.Fatalf("waiting for the old code: err = %v, want ErrDeviceLoginExpired", err)
	}
	if _, err := f.service.WaitQRSignIn(t.Context(), "nope"); !errors.Is(err, nuvio.ErrDeviceLoginExpired) {
		t.Fatalf("waiting for an unknown code: err = %v, want ErrDeviceLoginExpired", err)
	}
}

func TestQRSignInBacksOff(t *testing.T) {
	f := newFixture(t)
	f.backend.FailPolls.Store(3)
	waits := phoneApproves(t, f, 5, "me@example.com")
	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := f.service.WaitQRSignIn(t.Context(), code.Code); err != nil {
		t.Fatal(err)
	}
	// 3 s, then doubling after each failed poll (the client's own 429
	// retries aside), then the backend's interval again.
	want := []time.Duration{3 * time.Second, 6 * time.Second, 12 * time.Second, 24 * time.Second, 3 * time.Second}
	if got := waits(); !slices.Equal(got, want) {
		t.Fatalf("waits = %v, want %v", got, want)
	}
}

func TestQRSignInOfflinePastExpiry(t *testing.T) {
	f := newFixture(t)
	f.backend.FailPolls.Store(1000)
	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	waited := time.Duration(0)
	f.service.sleep = func(_ context.Context, d time.Duration) error {
		waited += d
		return nil
	}
	f.service.session.now = func() time.Time { return time.Now().Add(waited) }

	_, err = f.service.WaitQRSignIn(t.Context(), code.Code)
	if !errors.Is(err, nuvio.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if waited < 5*time.Minute || waited > 6*time.Minute {
		t.Fatalf("gave up after %v, want just past the 5 minutes", waited)
	}
}

func TestQRSignInCancelled(t *testing.T) {
	f := newFixture(t)
	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	f.service.sleep = func(context.Context, time.Duration) error {
		cancel()
		return ctx.Err()
	}
	if _, err := f.service.WaitQRSignIn(ctx, code.Code); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	// The code is still pending, and the next wait can sign in with it.
	phoneApproves(t, f, 1, "me@example.com")
	if _, err := f.service.WaitQRSignIn(t.Context(), code.Code); err != nil {
		t.Fatal(err)
	}
}

func TestQRSignInNeedsKeychain(t *testing.T) {
	f := newFixture(t)
	f.keychain.unavailable = true
	if _, err := f.service.StartQRSignIn(t.Context()); !errors.Is(err, secrets.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if calls := f.backend.Calls(); len(calls) != 0 {
		t.Fatalf("calls = %q, want none", calls)
	}
}

func TestQRSignInKeepsNothingIfLinkingFails(t *testing.T) {
	f := newFixture(t)
	f.backend.FailProfiles.Store(true)
	phoneApproves(t, f, 1, "me@example.com")
	code, err := f.service.StartQRSignIn(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := f.service.WaitQRSignIn(t.Context(), code.Code); !errors.Is(err, nuvio.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
	// The exchanged session isn't left open on the account.
	if calls := f.backend.Calls(); calls[len(calls)-1] != "POST /auth/v1/logout?scope=local" {
		t.Fatalf("calls = %q, want a sign-out last", calls)
	}
}

func TestQRPath(t *testing.T) {
	code, err := qr.Encode("https://nuvio.tv/link?code=ABC234", qr.M)
	if err != nil {
		t.Fatal(err)
	}
	// Redraw the path's rectangles and compare them with the code.
	drawn := map[[2]int]bool{}
	for _, rect := range strings.Split(strings.TrimSuffix(qrPath(code), "z"), "z") {
		var x, y, w, back int
		if _, err := fmt.Sscanf(rect, "M%d %dh%dv1h-%d", &x, &y, &w, &back); err != nil || w != back {
			t.Fatalf("rect %q: %v", rect, err)
		}
		for i := range w {
			drawn[[2]int{x + i, y}] = true
		}
	}
	for y := range code.Size {
		for x := range code.Size {
			if drawn[[2]int{x, y}] != code.Black(x, y) {
				t.Fatalf("module %d,%d drawn %v, want %v", x, y, drawn[[2]int{x, y}], code.Black(x, y))
			}
		}
	}
}

func TestDeviceName(t *testing.T) {
	if name := deviceName(); !strings.HasPrefix(name, "Peli") || strings.Contains(name, ".") {
		t.Fatalf("device name = %q", name)
	}
}
