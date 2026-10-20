package nuvio

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
)

func newTestClient(url string) *Client {
	c := New(url, "1.2.3")
	c.sleep = func(context.Context, time.Duration) error { return nil }
	return c
}

func TestSignInWithPassword(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)

	before := time.Now()
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if access, refresh := b.Tokens(); s.AccessToken != access || s.RefreshToken != refresh {
		t.Fatalf("session = %+v", s)
	}
	if s.UserID != nuviotest.UserID("me@example.com") {
		t.Fatalf("user = %q", s.UserID)
	}
	// The JWT's exp is in whole seconds.
	if got := s.ExpiresAt.Sub(before); got < 7*24*time.Hour-time.Second || got > 7*24*time.Hour+time.Minute {
		t.Fatalf("expires in %v, want 7 days", got)
	}
	if calls := b.Calls(); len(calls) != 1 || calls[0] != "POST /auth/v1/token?grant_type=password" {
		t.Fatalf("calls = %q", calls)
	}
	if body := b.Body("/auth/v1/token"); body["email"] != "me@example.com" {
		t.Fatalf("body = %v", body)
	}
	if got := b.UserAgents()[0]; got != "Sinag/1.2.3 (+https://github.com/k22i/Sinag)" {
		t.Fatalf("User-Agent = %q", got)
	}
}

func TestSignInWithWrongPassword(t *testing.T) {
	b := nuviotest.NewServer(t)
	_, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", "wrong")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
	if n := len(b.Calls()); n != 1 {
		t.Fatalf("%d calls, want 1: a wrong password isn't retried", n)
	}
}

func TestRateLimitBacksOffThenSucceeds(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(2)
	c := newTestClient(b.URL)
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}

	if _, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	if len(waits) != 2 {
		t.Fatalf("waited %d times, want 2", len(waits))
	}
	// Full jitter: each wait is below its doubling cap.
	for i, wait := range waits {
		if limit := c.backoff << i; wait < 0 || wait >= limit {
			t.Fatalf("wait %d = %v, want under %v", i, wait, limit)
		}
	}
}

func TestRateLimitGivesUp(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(100)
	_, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	if n := len(b.Calls()); n != 3 {
		t.Fatalf("%d calls, want 3 (two retries)", n)
	}
}

func TestRateLimitBackoffStopsWithContext(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(100)
	c := New(b.URL, "1.2.3")
	if _, err := c.publishableKey(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	c.sleep = func(ctx context.Context, d time.Duration) error {
		cancel()
		return sleep(ctx, time.Hour)
	}
	if _, err := c.SignInWithPassword(ctx, "me@example.com", nuviotest.Password); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestUnreachable(t *testing.T) {
	b := nuviotest.NewServer(t)
	url := b.URL
	b.Close()
	_, err := newTestClient(url).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrUnreachable) {
		t.Fatalf("err = %v, want ErrUnreachable", err)
	}
}

func TestServerError(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html>502 Bad Gateway</html>"))
	}))
	defer s.Close()
	_, err := newTestClient(s.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestNotANuvioBackend(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"service":"something-else"}`))
	}))
	defer s.Close()
	_, err := newTestClient(s.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err == nil || !strings.Contains(err.Error(), "not a Nuvio backend") {
		t.Fatalf("err = %v", err)
	}
}

func TestProfilesAndSignOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 2 || profiles[0].Index != 1 || profiles[0].Name != "Kevin" ||
		profiles[1].Index != 3 || !profiles[1].PinEnabled || *profiles[1].AvatarURL != "https://img/a7.png" {
		t.Fatalf("profiles = %+v", profiles)
	}

	if err := c.SignOut(t.Context(), s); err != nil {
		t.Fatal(err)
	}
}

func TestPatchProfile(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	// Only what's set is sent: the rest of the profile is kept.
	name := "Kev"
	p, err := c.PatchProfile(t.Context(), s, 1, ProfilePatch{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if body := b.Body("/rest/v1/rpc/sync_patch_profile"); len(body) != 2 || body["p_name"] != "Kev" {
		t.Fatalf("body = %v", body)
	}
	if p.Index != 1 || p.Name != "Kev" || p.AvatarColor != "#33B5E0" || *p.AvatarID != "a1" {
		t.Fatalf("profile = %+v", p)
	}

	// A stock avatar replaces a custom image.
	avatar, color := "a1", "#E53935"
	p, err = c.PatchProfile(t.Context(), s, 3, ProfilePatch{AvatarID: &avatar, AvatarColor: &color})
	if err != nil {
		t.Fatal(err)
	}
	if body := b.Body("/rest/v1/rpc/sync_patch_profile"); body["p_avatar_id_provided"] != true {
		t.Fatalf("body = %v", body)
	}
	if p.AvatarURL != nil || *p.AvatarID != "a1" || p.AvatarColor != "#E53935" || p.Name != "Kids" {
		t.Fatalf("profile = %+v", p)
	}

	// Deleted on another device.
	if _, err := c.PatchProfile(t.Context(), s, 2, ProfilePatch{Name: &name}); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("err = %v, want ErrProfileNotFound", err)
	}
	empty := " "
	var apiErr *APIError
	if _, err := c.PatchProfile(t.Context(), s, 1, ProfilePatch{Name: &empty}); !errors.As(err, &apiErr) || apiErr.Code != "22023" {
		t.Fatalf("err = %v, want 22023", err)
	}
}

func TestPushAndDeleteProfiles(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}

	// The full list round-trips, with a new profile at index 2.
	avatar := "a7"
	profiles = append(profiles, Profile{Index: 2, Name: "Guests", AvatarColor: "#43A047", AvatarID: &avatar})
	if err := c.PushProfiles(t.Context(), s, profiles); err != nil {
		t.Fatal(err)
	}
	body := b.Body("/rest/v1/rpc/sync_push_profiles")
	if body["p_client_max_profiles"] != float64(MaxProfiles) {
		t.Fatalf("body = %v", body)
	}
	// Profile 3's custom image wins over its stock avatar, as Nuvio's
	// dashboard sends it.
	if kids := body["p_profiles"].([]any)[1].(map[string]any); kids["avatar_id"] != nil || kids["avatar_url"] != "https://img/a7.png" || kids["uses_primary_addons"] != true {
		t.Fatalf("pushed %v", kids)
	}
	after, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 3 || after[1].Name != "Guests" || *after[1].AvatarID != "a7" ||
		after[2].Name != "Kids" || after[2].AvatarColor != "#F5A623" || !after[2].UsesPrimaryAddons || !after[2].PinEnabled {
		t.Fatalf("profiles = %+v", after)
	}

	if err := c.DeleteProfile(t.Context(), s, 2); err != nil {
		t.Fatal(err)
	}
	if after, _ := c.Profiles(t.Context(), s); len(after) != 2 || after[1].Index != 3 {
		t.Fatalf("profiles = %+v", after)
	}
}

func TestAvatarCatalog(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL + "/")

	// No session needed.
	avatars, err := c.AvatarCatalog(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(avatars) != 2 || avatars[0] != (Avatar{ID: "a1", Name: "Otto", Path: "animals/otto-v1.png", Color: "#0BB5AE"}) {
		t.Fatalf("avatars = %+v", avatars)
	}
	want := b.URL + "/storage/v1/object/public/avatars/animals/otto-v1.png"
	if got := c.AvatarImageURL(avatars[0]); got != want {
		t.Fatalf("image = %q, want %q", got, want)
	}
	if got := c.AvatarImageURL(Avatar{Path: "new/a b?.png"}); !strings.HasSuffix(got, "/avatars/new/a%20b%3F.png") {
		t.Fatalf("image = %q, want its segments escaped", got)
	}
}

func TestSignedOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	_, err := newTestClient(b.URL).Profiles(t.Context(), Session{AccessToken: "revoked"})
	if !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestDiscoveryIsReadOnce(t *testing.T) {
	var discoveries atomic.Int32
	b := nuviotest.NewServer(t)
	inner := b.Config.Handler
	b.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/nuvio" {
			discoveries.Add(1)
		}
		inner.ServeHTTP(w, r)
	})
	c := newTestClient(b.URL)
	for range 3 {
		c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	}
	if n := discoveries.Load(); n != 1 {
		t.Fatalf("read the discovery document %d times, want 1", n)
	}
}

func TestRefreshRotates(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	first, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	second, err := c.Refresh(t.Context(), first.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if second.RefreshToken == first.RefreshToken || second.AccessToken == first.AccessToken {
		t.Fatalf("refresh kept the old tokens: %+v", second)
	}
	if second.UserID != first.UserID || second.ExpiresAt.Before(first.ExpiresAt) {
		t.Fatalf("refreshed session = %+v, first %+v", second, first)
	}
	if body := b.Body("/auth/v1/token"); body["refresh_token"] != first.RefreshToken {
		t.Fatalf("body = %v", body)
	}

	// A second refresher with the same token gets the same new session, as
	// on live.
	again, err := c.Refresh(t.Context(), first.RefreshToken)
	if err != nil || again.RefreshToken != second.RefreshToken {
		t.Fatalf("reusing the last token: %v, same session %v", err, again.RefreshToken == second.RefreshToken)
	}

	// Once the newest has been used, the first is two behind and refused;
	// the newest still works.
	third, err := c.Refresh(t.Context(), second.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Refresh(t.Context(), first.RefreshToken); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("reusing an old token: err = %v, want ErrSignedOut", err)
	}
	if _, err := c.Refresh(t.Context(), third.RefreshToken); err != nil {
		t.Fatalf("the newest token after a reuse: %v", err)
	}
}

func TestRefreshAfterSignOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.SignOut(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Refresh(t.Context(), s.RefreshToken); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestRefreshWithOldGoTrue(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/nuvio" {
			w.Write([]byte(`{"service":"nuvio","publishable_key":"k"}`))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant","error_description":"Invalid Refresh Token"}`))
	}))
	defer s.Close()
	if _, err := newTestClient(s.URL).Refresh(t.Context(), "spent"); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestSessionFromTokens(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Lifetime.Store(3600)
	if _, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	access, refresh := b.Tokens()

	s := SessionFromTokens(access, refresh)
	if s.UserID != nuviotest.UserID("me@example.com") || s.RefreshToken != refresh {
		t.Fatalf("session = %+v", s)
	}
	if left := time.Until(s.ExpiresAt); left < 59*time.Minute || left > time.Hour {
		t.Fatalf("expires in %v, want an hour", left)
	}

	for _, token := range []string{"", "opaque", "a.!!!.c", "a.bm90IGpzb24.c"} {
		if s := SessionFromTokens(token, refresh); !s.ExpiresAt.IsZero() || s.UserID != "" {
			t.Errorf("SessionFromTokens(%q) = %+v, want no claims", token, s)
		}
	}
}

func TestDeviceLogin(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)

	login, err := c.StartDeviceLogin(t.Context(), DefaultLinkURL, "Sinag on test-mac")
	if err != nil {
		t.Fatal(err)
	}
	if login.UserCode == "" || login.URL != DefaultLinkURL+"?code="+login.UserCode || login.LinkURL != DefaultLinkURL {
		t.Fatalf("login = %+v", login)
	}
	if left := time.Until(login.ExpiresAt); left < 4*time.Minute || left > 5*time.Minute {
		t.Fatalf("expires in %v, want 5 min", left)
	}
	if login.PollInterval != 3*time.Second {
		t.Fatalf("poll interval = %v", login.PollInterval)
	}
	body := b.Body("/rest/v1/rpc/start_device_login_session")
	if nonce, _ := body["p_device_nonce"].(string); len(nonce) != 48 || body["p_device_name"] != "Sinag on test-mac" || body["p_device_type"] != "desktop" {
		t.Fatalf("start body = %v", body)
	}

	if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginPending {
		t.Fatalf("poll = %q, %v; want pending", status, err)
	}
	if _, err := c.ExchangeDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
		t.Fatalf("exchange before approval: err = %v, want ErrDeviceLoginExpired", err)
	}
	if !b.Approve(login.UserCode, "me@example.com") {
		t.Fatal("no login to approve")
	}
	status, interval, err := c.PollDeviceLogin(t.Context(), login)
	if err != nil || status != DeviceLoginApproved || interval != 3*time.Second {
		t.Fatalf("poll = %q, %v, %v; want approved", status, interval, err)
	}

	s, err := c.ExchangeDeviceLogin(t.Context(), login)
	if err != nil {
		t.Fatal(err)
	}
	if access, refresh := b.Tokens(); s.AccessToken != access || s.RefreshToken != refresh || s.UserID != nuviotest.UserID("me@example.com") {
		t.Fatalf("session = %+v", s)
	}
	if _, err := c.Profiles(t.Context(), s); err != nil {
		t.Fatalf("profiles with the exchanged session: %v", err)
	}
	// An exchange works once.
	if _, err := c.ExchangeDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
		t.Fatalf("second exchange: err = %v, want ErrDeviceLoginExpired", err)
	}
}

func TestDeviceLoginExpires(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	login, err := c.StartDeviceLogin(t.Context(), DefaultLinkURL, "Sinag")
	if err != nil {
		t.Fatal(err)
	}
	b.ExpireDeviceLogins()

	if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginExpired {
		t.Fatalf("poll = %q, %v; want expired", status, err)
	}
	if b.Approve(login.UserCode, "me@example.com") {
		t.Fatal("approved an expired login")
	}
	if _, err := c.ExchangeDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
		t.Fatalf("exchange: err = %v, want ErrDeviceLoginExpired", err)
	}
}

func TestDeviceLoginUnknown(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	login := DeviceLogin{deviceCode: "nope", nonce: "nope-nope-nope"}
	if _, _, err := c.PollDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
		t.Fatalf("poll: err = %v, want ErrDeviceLoginExpired", err)
	}
	if _, err := c.StartDeviceLogin(t.Context(), "https://nuvio.tv/tv-login", "Sinag"); err == nil {
		t.Fatal("started a login with a redirect that isn't /link")
	}
}
