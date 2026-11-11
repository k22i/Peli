package nuvio

import (
	"cmp"
	"context"
	"errors"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestLive signs in to a real backend, reads the profiles, refreshes and
// signs out again, leaving nothing behind: the per-release live check of
// ADR-0004. It runs only with PELI_NUVIO_LIVE=1 and an account in
// NUVIO_EMAIL and NUVIO_PASSWORD (NUVIO_URL defaults to api.nuvio.tv). It
// logs timings and counts, never the account's data.
func TestLive(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE") != "1" {
		t.Skip("set PELI_NUVIO_LIVE=1, NUVIO_EMAIL and NUVIO_PASSWORD to sign in to a live backend")
	}
	url := os.Getenv("NUVIO_URL")
	if url == "" {
		url = DefaultURL
	}
	c := New(url, "0.0.0-live-test")

	start := time.Now()
	if _, _, err := c.publishableKey(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Logf("discovery: %v", time.Since(start).Round(time.Millisecond))

	if _, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), "not the password"); err != ErrInvalidCredentials {
		t.Fatalf("wrong password: err = %v, want ErrInvalidCredentials", err)
	}

	start = time.Now()
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	signIn := time.Since(start)
	// Not t.Context(): it is cancelled before cleanups run. The session may
	// have ended already.
	latest := s
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), latest); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	t.Logf("sign in: %v, session lasts %v", signIn.Round(time.Millisecond), time.Until(s.ExpiresAt).Round(time.Hour))

	start = time.Now()
	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("profiles: %v, %d profile(s); sign-in to profiles: %v",
		time.Since(start).Round(time.Millisecond), len(profiles), (signIn + time.Since(start)).Round(time.Millisecond))
	for _, p := range profiles {
		if p.Index < 1 || p.Index > 6 || p.Name == "" {
			t.Errorf("profile with index %d and a name of %d bytes", p.Index, len(p.Name))
		}
	}

	// Every profile's stock avatar is in the catalog, and its image is
	// public (#24).
	start = time.Now()
	avatars, err := c.AvatarCatalog(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("avatar catalog: %v, %d avatar(s)", time.Since(start).Round(time.Millisecond), len(avatars))
	images := map[string]string{}
	for _, a := range avatars {
		images[a.ID] = c.AvatarImageURL(a)
	}
	for _, p := range profiles {
		if p.AvatarURL == nil && p.AvatarID != nil && images[*p.AvatarID] == "" {
			t.Errorf("profile %d's avatar isn't in the catalog", p.Index)
		}
	}
	if len(avatars) > 0 {
		resp, err := http.Get(images[avatars[0].ID])
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
			t.Errorf("avatar image: HTTP %d, %s", resp.StatusCode, resp.Header.Get("Content-Type"))
		}
	}

	// Refresh rotates both tokens, and the new session works (#22).
	start = time.Now()
	refreshed, err := c.Refresh(t.Context(), s.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	latest = refreshed
	t.Logf("refresh: %v, session lasts %v", time.Since(start).Round(time.Millisecond), time.Until(refreshed.ExpiresAt).Round(time.Hour))
	if refreshed.AccessToken == s.AccessToken || refreshed.RefreshToken == s.RefreshToken {
		t.Error("refresh kept a token")
	}
	if refreshed.UserID == "" || refreshed.UserID != s.UserID || refreshed.ExpiresAt.Before(s.ExpiresAt) {
		t.Error("refreshed session's claims don't match the first")
	}
	if _, err := c.Profiles(t.Context(), refreshed); err != nil {
		t.Fatalf("profiles after refresh: %v", err)
	}

	// Signing out ends the session on the backend: its refresh token stops
	// working.
	if err := c.SignOut(t.Context(), refreshed); err != nil {
		t.Fatal(err)
	}
	_, err = c.Refresh(t.Context(), refreshed.RefreshToken)
	t.Logf("refresh after sign-out: %v", err)
	if !errors.Is(err, ErrSignedOut) {
		t.Fatalf("refresh after sign-out: err = %v, want ErrSignedOut", err)
	}
}

// TestLiveRefreshTokenReuse checks what a second refresher with the same
// refresh token gets on live: the same new session, not a sign-out. (A probe
// in #22 still got it 8 minutes later.) Gotcha 6 feared the opposite.
func TestLiveRefreshTokenReuse(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE") != "1" {
		t.Skip("set PELI_NUVIO_LIVE=1, NUVIO_EMAIL and NUVIO_PASSWORD to sign in to a live backend")
	}
	c := New(cmp.Or(os.Getenv("NUVIO_URL"), DefaultURL), "0.0.0-live-test")
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	next, err := c.Refresh(t.Context(), s.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), next); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})

	again, err := c.Refresh(t.Context(), s.RefreshToken)
	if err != nil {
		t.Fatalf("second refresh with the same token: %v", err)
	}
	if again.RefreshToken != next.RefreshToken {
		t.Error("second refresh with the same token got a different session")
	}
	if _, err := c.Refresh(t.Context(), next.RefreshToken); err != nil {
		t.Fatalf("refreshing the newest token after that: %v", err)
	}
}

// TestLiveDeviceLogin signs in by device login (#21) on a real backend,
// with a password session standing in for the phone: it approves the code
// with approve_device_login_session, as nuvio.tv/link does. Both sessions
// sign out at the end. It runs only with PELI_NUVIO_LIVE=1 and an account in
// NUVIO_EMAIL and NUVIO_PASSWORD, and never logs the codes.
func TestLiveDeviceLogin(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE") != "1" {
		t.Skip("set PELI_NUVIO_LIVE=1, NUVIO_EMAIL and NUVIO_PASSWORD to sign in to a live backend")
	}
	c := New(cmp.Or(os.Getenv("NUVIO_URL"), DefaultURL), "0.0.0-live-test")
	phone, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), phone); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out the approving session: %v", err)
		}
	})

	start := time.Now()
	login, err := c.StartDeviceLogin(t.Context(), DefaultLinkURL, "Peli live test")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("start: %v; user code of %d characters, expires in %v, poll every %v",
		time.Since(start).Round(time.Millisecond), len(login.UserCode),
		time.Until(login.ExpiresAt).Round(time.Second), login.PollInterval)
	if !strings.HasPrefix(login.URL, DefaultLinkURL+"?code=") || login.LinkURL != DefaultLinkURL {
		t.Errorf("URL isn't %s?code=…, or the link URL isn't %s", DefaultLinkURL, DefaultLinkURL)
	}
	if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginPending {
		t.Fatalf("poll before approval = %q, %v; want pending", status, err)
	}

	var approved []struct {
		Success    bool   `json:"success"`
		Message    string `json:"message"`
		DeviceName string `json:"device_name"`
		DeviceType string `json:"device_type"`
	}
	if err := c.call(t.Context(), http.MethodPost, "/rest/v1/rpc/approve_device_login_session", phone.AccessToken,
		map[string]any{"p_user_code": login.UserCode}, &approved); err != nil {
		t.Fatal(err)
	}
	if len(approved) != 1 || !approved[0].Success {
		t.Fatalf("approve = %+v", approved)
	}
	t.Logf("approved; the approving device saw %q (%s)", approved[0].DeviceName, approved[0].DeviceType)

	time.Sleep(login.PollInterval)
	if status, _, err := c.PollDeviceLogin(t.Context(), login); err != nil || status != DeviceLoginApproved {
		t.Fatalf("poll after approval = %q, %v; want approved", status, err)
	}
	start = time.Now()
	s, err := c.ExchangeDeviceLogin(t.Context(), login)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	t.Logf("exchange: %v, session lasts %v", time.Since(start).Round(time.Millisecond), time.Until(s.ExpiresAt).Round(time.Hour))
	if s.UserID == "" || s.UserID != phone.UserID {
		t.Error("the exchanged session isn't the approving account's")
	}
	if _, err := c.Profiles(t.Context(), s); err != nil {
		t.Fatalf("profiles with the exchanged session: %v", err)
	}
	if _, err := c.ExchangeDeviceLogin(t.Context(), login); !errors.Is(err, ErrDeviceLoginExpired) {
		t.Errorf("second exchange: err = %v, want ErrDeviceLoginExpired", err)
	}
	status, _, err := c.PollDeviceLogin(t.Context(), login)
	t.Logf("poll after the exchange: %q, %v", status, err)
}

// TestLiveProfiles checks the profile writes of #95 on a real account, with
// every change undone: a patch that changes nothing, a rename of profile 1
// and back, and a profile added at a free index and deleted. Then every
// profile must be as it was. It refuses to write if the profiles have a field
// a push wouldn't send back. It runs only with PELI_NUVIO_LIVE_WRITES=1 and
// an account in NUVIO_EMAIL and NUVIO_PASSWORD, and logs field names, never
// the account's data.
func TestLiveProfiles(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE_WRITES") != "1" {
		t.Skip("set PELI_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD to write to a live account's profiles")
	}
	c := New(cmp.Or(os.Getenv("NUVIO_URL"), DefaultURL), "0.0.0-live-test")
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})

	// Every field as the backend sends it, but when it was last changed.
	raw := func() []map[string]any {
		t.Helper()
		var rows []map[string]any
		if err := c.call(context.Background(), http.MethodPost, "/rest/v1/rpc/sync_pull_profiles", s.AccessToken, map[string]any{}, &rows); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			delete(row, "updated_at")
		}
		return rows
	}
	before := raw()
	pushed := map[string]bool{"profile_index": true, "name": true, "avatar_color_hex": true, "avatar_id": true, "avatar_url": true, "uses_primary_addons": true, "uses_primary_plugins": true}
	kept := map[string]bool{"id": true, "user_id": true, "pin_enabled": true, "pin_locked_until": true, "created_at": true}
	var fields, unknown []string
	for _, row := range before {
		for k, v := range row {
			if !slices.Contains(fields, k) {
				fields = append(fields, k)
			}
			if !pushed[k] && !kept[k] && v != nil && v != false && !slices.Contains(unknown, k) {
				unknown = append(unknown, k)
			}
		}
	}
	slices.Sort(fields)
	t.Logf("%d profile(s); fields: %s", len(before), strings.Join(fields, ", "))
	if len(before) == 0 || len(unknown) > 0 {
		t.Skipf("not writing: no profiles, or fields a push wouldn't send back are set: %v", unknown)
	}
	unchanged := func(when string) {
		t.Helper()
		after := raw()
		if len(after) != len(before) {
			t.Fatalf("%s: %d profile(s), was %d", when, len(after), len(before))
		}
		for i := range before {
			for k := range before[i] {
				if !reflect.DeepEqual(before[i][k], after[i][k]) {
					t.Errorf("%s: profile %v's %s changed", when, before[i]["profile_index"], k)
				}
			}
		}
	}

	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	first := profiles[0]

	// A patch with nothing in it returns the profile: the call exists on live.
	start := time.Now()
	got, err := c.PatchProfile(t.Context(), s, first.Index, ProfilePatch{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("empty patch: %v", time.Since(start).Round(time.Millisecond))
	if got.Name != first.Name || got.AvatarColor != first.AvatarColor {
		t.Fatal("empty patch returned another profile")
	}

	// Rename and back.
	original, renamed := first.Name, first.Name+" (Peli test)"
	restore := func() {
		if _, err := c.PatchProfile(context.Background(), s, first.Index, ProfilePatch{Name: &original}); err != nil {
			t.Errorf("restoring profile %d's name: %v", first.Index, err)
		}
	}
	got, err = c.PatchProfile(t.Context(), s, first.Index, ProfilePatch{Name: &renamed})
	if err != nil {
		restore()
		t.Fatal(err)
	}
	restore()
	if got.Name != renamed {
		t.Error("rename didn't take")
	}
	unchanged("after a rename and back")

	// Add at a free index, then delete it.
	if len(profiles) >= MaxProfiles {
		t.Skip("every profile is in use: not adding one")
	}
	index := 0
	for i := MaxProfiles; i >= 1; i-- {
		if !slices.ContainsFunc(profiles, func(p Profile) bool { return p.Index == i }) {
			index = i
		}
	}
	start = time.Now()
	err = c.PushProfiles(t.Context(), s, append(profiles, Profile{Index: index, Name: "Peli test", AvatarColor: "#33B5E0"}))
	t.Cleanup(func() {
		if err := c.DeleteProfile(context.Background(), s, index); err != nil {
			t.Errorf("deleting the test profile %d: %v", index, err)
		}
		unchanged("after adding a profile and deleting it")
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("push with a new profile %d: %v", index, time.Since(start).Round(time.Millisecond))
	after, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(profiles)+1 || !slices.ContainsFunc(after, func(p Profile) bool { return p.Index == index && p.Name == "Peli test" }) {
		t.Errorf("after the push: %d profile(s), want %d with the new one", len(after), len(profiles)+1)
	}
}

// TestLiveSync is the write half of the per-release live check
// (docs/nuvio-release-checklist.md): one progress push to a real account and
// its delete, with every answer checked against the contract (#33). It
// catches drift between live and the self-host stack CI tests against. The
// entry is far from 90 %, so no watched item is added. It runs only with
// PELI_NUVIO_LIVE_WRITES=1 and an account in NUVIO_EMAIL and
// NUVIO_PASSWORD, and logs counts, never the account's data.
func TestLiveSync(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE_WRITES") != "1" {
		t.Skip("set PELI_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD to push to and delete from a live account")
	}
	rec := newRecorder(t)
	c := New(cmp.Or(os.Getenv("NUVIO_URL"), DefaultURL), "0.0.0-live-test")
	c.http.Transport = rec
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	profiles, err := c.Profiles(t.Context(), s)
	if err != nil || len(profiles) == 0 {
		t.Fatalf("profiles = %d, %v", len(profiles), err)
	}
	index := profiles[0].Index

	// Read the feed to its end for a cursor.
	var cursor int64
	events := 0
	for {
		page, err := c.ProgressDelta(t.Context(), s, index, cursor)
		if err != nil {
			t.Fatal(err)
		}
		events += len(page)
		if len(page) > 0 {
			cursor = page[len(page)-1].EventID
		}
		if len(page) < DeltaLimit {
			break
		}
	}
	t.Logf("progress feed: %d event(s)", events)

	// Carmencita (1894): 5 s into 10 min, last watched now.
	entry := ProgressRow{ContentID: "tt0000001", ContentType: "movie", VideoID: "tt0000001",
		Position: 5_000, Duration: 600_000, LastWatched: time.Now().UnixMilli()}
	start := time.Now()
	if err := c.PushProgress(t.Context(), s, index, []ProgressRow{entry}); err != nil {
		t.Fatal(err)
	}
	pushed, err := c.ProgressDelta(t.Context(), s, index, cursor)
	key := ""
	if i := slices.IndexFunc(pushed, func(e ProgressEvent) bool { return e.ContentID == entry.ContentID }); i >= 0 {
		key = pushed[i].ProgressKey
		cursor = pushed[len(pushed)-1].EventID
	}
	undone := false
	t.Cleanup(func() {
		if undone {
			return
		}
		// A film's progress key is its content ID.
		if err := c.DeleteProgress(context.Background(), s, index, []string{cmp.Or(key, entry.ContentID)}); err != nil {
			t.Errorf("deleting the test progress: %v", err)
		}
	})
	if err != nil || key == "" {
		t.Fatalf("the push isn't in the feed: %d event(s), %v", len(pushed), err)
	}
	t.Logf("push to pull: %v", time.Since(start).Round(time.Millisecond))

	if err := c.DeleteProgress(t.Context(), s, index, []string{key}); err != nil {
		t.Fatal(err)
	}
	undone = true
	deleted, err := c.ProgressDelta(t.Context(), s, index, cursor)
	if err != nil || !slices.ContainsFunc(deleted, func(e ProgressEvent) bool { return e.ProgressKey == key && e.Operation == OpDelete }) {
		t.Fatalf("the delete isn't in the feed: %d event(s), %v", len(deleted), err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for path, fields := range rec.unread {
		slices.Sort(fields)
		t.Logf("%s also sends %s", path, strings.Join(fields, ", "))
	}
}
