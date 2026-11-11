package tracking

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/anilist"
	"github.com/k22i/Peli/internal/simkl"
	"github.com/k22i/Peli/internal/store"
)

// --- SIMKL (#72): AUTH V2's device flow ---------------------------------------
//
// Settings shows the code and opens SIMKL's page with it filled in; the user
// clicks Allow there. SIMKL never says no (a refusal looks like waiting), so
// the wait gives up when the code expires, after 15 minutes.

// SimklCode is a pending SIMKL sign-in, for Settings to show.
type SimklCode struct {
	// The code, as SIMKL shows it ("BDWP-HQPK"), and the page to enter it
	// on; URL has it filled in.
	Code      string    `json:"code"`
	URL       string    `json:"url"`
	PageURL   string    `json:"pageUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type simklSignIn struct {
	profileID uint64
	code      simkl.DeviceCode
	expires   time.Time
	cancel    context.CancelFunc
	ctx       context.Context
}

// StartSimkl starts connecting profile id to SIMKL, replacing any sign-in
// pending. WaitSimkl then waits for the user to approve it.
func (s *Service) StartSimkl(ctx context.Context, profileID uint64) (SimklCode, error) {
	if !s.simkl.Configured() {
		return SimklCode{}, ErrUnavailableHere
	}
	if err := s.canConnect(profileID); err != nil {
		return SimklCode{}, err
	}
	code, err := s.simkl.StartDevice(ctx)
	if err != nil {
		return SimklCode{}, wrap("start SIMKL sign-in", err)
	}
	expires := s.now().Add(time.Duration(max(code.ExpiresIn, 60)) * time.Second)
	waitCtx, cancel := context.WithDeadline(context.Background(), expires)
	s.signInMu.Lock()
	if s.simklIn != nil {
		s.simklIn.cancel()
	}
	s.simklIn = &simklSignIn{profileID: profileID, code: code, expires: expires, ctx: waitCtx, cancel: cancel}
	s.signInMu.Unlock()
	url := code.VerificationURIComplete
	if url == "" {
		url = code.VerificationURI
	}
	return SimklCode{Code: code.UserCode, URL: url, PageURL: code.VerificationURI, ExpiresAt: expires}, nil
}

// WaitSimkl waits for the pending SIMKL sign-in to be approved, then keeps
// its tokens and returns the profile's connections. It fails with
// ErrSignInExpired when the code runs out, and ErrNoSignIn when it was
// cancelled or replaced.
func (s *Service) WaitSimkl(ctx context.Context) (Connections, error) {
	s.signInMu.Lock()
	in := s.simklIn
	s.signInMu.Unlock()
	if in == nil {
		return Connections{}, ErrNoSignIn
	}
	interval := time.Duration(max(in.code.Interval, 5)) * time.Second
	for {
		if err := s.sleepEither(ctx, in.ctx, interval); err != nil {
			return Connections{}, s.waitErr(ctx, in.ctx, in.expires)
		}
		token, err := s.simkl.PollDevice(ctx, in.code.DeviceCode)
		switch {
		case errors.Is(err, simkl.ErrPending), simkl.Temporary(err):
			continue
		case errors.Is(err, simkl.ErrSlowDown):
			interval += 5 * time.Second
			continue
		case errors.Is(err, simkl.ErrCodeGone):
			return Connections{}, ErrSignInExpired
		case err != nil:
			return Connections{}, wrap("SIMKL sign-in", err)
		}
		s.endSimklSignIn(in)
		if err := s.keepSimkl(ctx, in.profileID, token); err != nil {
			return Connections{}, err
		}
		s.connected(in.profileID)
		return s.Status(in.profileID)
	}
}

// CancelSimkl drops the pending SIMKL sign-in.
func (s *Service) CancelSimkl() {
	s.signInMu.Lock()
	defer s.signInMu.Unlock()
	if s.simklIn != nil {
		s.simklIn.cancel()
		s.simklIn = nil
	}
}

func (s *Service) endSimklSignIn(in *simklSignIn) {
	s.signInMu.Lock()
	defer s.signInMu.Unlock()
	in.cancel()
	if s.simklIn == in {
		s.simklIn = nil
	}
}

// sleepEither sleeps d unless ctx or other ends first.
func (s *Service) sleepEither(ctx, other context.Context, d time.Duration) error {
	both, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(other, cancel)
	defer stop()
	return s.sleep(both, d)
}

func (s *Service) waitErr(ctx, sign context.Context, expires time.Time) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(sign.Err(), context.DeadlineExceeded) || !s.now().Before(expires) {
		return ErrSignInExpired
	}
	return ErrNoSignIn
}

// keepSimkl checks a new grant can scrobble, finds whose it is, and keeps
// it for profile id.
func (s *Service) keepSimkl(ctx context.Context, profileID uint64, token simkl.Token) error {
	if !token.CanWrite() {
		_ = s.simkl.Revoke(ctx, token.RefreshToken)
		return simkl.ErrReadOnly
	}
	user, err := s.simkl.Settings(ctx, token.AccessToken)
	if err != nil {
		return wrap("SIMKL account", err)
	}
	if err := s.saveSimklTokens(profileID, token); err != nil {
		return err
	}
	return s.open().UpdateTracking(profileID, func(t *store.Tracking) error {
		t.Simkl = &store.SimklLink{User: user.User.Name, AccessExpires: s.expiry(token)}
		return nil
	})
}

func (s *Service) saveSimklTokens(profileID uint64, token simkl.Token) error {
	if err := s.open().SetTrackingTokenOwner(profileID, true); err != nil {
		return err
	}
	if err := s.keychain.Set(simklAccessKey(profileID), token.AccessToken); err != nil {
		return err
	}
	return s.keychain.Set(simklRefreshKey(profileID), token.RefreshToken)
}

func (s *Service) expiry(token simkl.Token) int64 {
	return s.now().Add(time.Duration(token.ExpiresIn) * time.Second).UnixMilli()
}

// DisconnectSimkl revokes profile id's SIMKL grant (best effort: offline,
// it's just forgotten) and removes its tokens, connection and queued
// scrobbles.
func (s *Service) DisconnectSimkl(ctx context.Context, profileID uint64) (Connections, error) {
	if refresh, err := s.keychain.Get(simklRefreshKey(profileID)); err == nil {
		revokeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_ = s.simkl.Revoke(revokeCtx, refresh)
		cancel()
	}
	return s.disconnect(profileID, ServiceSimkl)
}

func (s *Service) disconnect(profileID uint64, service string) (Connections, error) {
	db := s.open()
	err := db.UpdateTracking(profileID, func(t *store.Tracking) error {
		if service == ServiceSimkl {
			t.Simkl = nil
		} else {
			t.AniList = nil
		}
		return nil
	})
	if err != nil {
		return Connections{}, err
	}
	s.forgetTokens(profileID, service)
	if err := db.DropTrackingJobs(profileID, service); err != nil {
		return Connections{}, err
	}
	if t, err := db.Tracking(profileID); err == nil && t.Simkl == nil && t.AniList == nil {
		_ = db.SetTrackingTokenOwner(profileID, false)
	}
	return s.Status(profileID)
}

// --- AniList (#104): the implicit grant to a loopback redirect --------------------
//
// AniList's apps have one redirect URL, and its authorization code grant
// needs the app's secret, which a desktop app can't keep. So Peli uses the
// implicit grant, redirected to a page Peli serves on this computer while
// the sign-in is pending: the token comes in the URL's fragment, which only
// the page's script can read, and it posts it back.

// AniListPort and AniListRedirect are what the AniList app is registered
// with.
const (
	AniListPort     = 47613
	AniListRedirect = "http://127.0.0.1:47613/anilist"
)

var errPortInUse = errors.New("tracking: the AniList sign-in port is in use")

// aniListWait is how long a pending AniList sign-in waits for the browser.
const aniListWait = 10 * time.Minute

type aniListSignIn struct {
	profileID uint64
	server    *http.Server
	tokens    chan string
	ctx       context.Context
	cancel    context.CancelFunc
	once      sync.Once
}

// StartAniList starts connecting profile id to AniList and returns the page
// to open in the browser. WaitAniList then waits for the user to approve.
func (s *Service) StartAniList(ctx context.Context, profileID uint64) (string, error) {
	if s.anilistID == "" {
		return "", ErrUnavailableHere
	}
	if err := s.canConnect(profileID); err != nil {
		return "", err
	}
	s.signInMu.Lock()
	defer s.signInMu.Unlock()
	if s.aniIn != nil {
		s.aniIn.close()
		s.aniIn = nil
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", AniListPort))
	if err != nil {
		return "", fmt.Errorf("%w: %w", errPortInUse, err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), aniListWait)
	in := &aniListSignIn{profileID: profileID, tokens: make(chan string, 1), ctx: waitCtx, cancel: cancel}
	in.server = &http.Server{Handler: aniListHandler(in.tokens), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = in.server.Serve(listener) }()
	context.AfterFunc(waitCtx, in.close)
	s.aniIn = in
	return anilist.AuthorizeURL(s.anilistID), nil
}

// WaitAniList waits for the browser to bring back the token, then keeps it
// and returns the profile's connections.
func (s *Service) WaitAniList(ctx context.Context) (Connections, error) {
	s.signInMu.Lock()
	in := s.aniIn
	s.signInMu.Unlock()
	if in == nil {
		return Connections{}, ErrNoSignIn
	}
	select {
	case <-ctx.Done():
		return Connections{}, ctx.Err()
	case <-in.ctx.Done():
		if errors.Is(in.ctx.Err(), context.DeadlineExceeded) {
			return Connections{}, ErrSignInExpired
		}
		return Connections{}, ErrNoSignIn
	case token := <-in.tokens:
		s.signInMu.Lock()
		if s.aniIn == in {
			s.aniIn = nil
		}
		s.signInMu.Unlock()
		in.close()
		if err := s.keepAniList(ctx, in.profileID, token); err != nil {
			return Connections{}, err
		}
		s.connected(in.profileID)
		return s.Status(in.profileID)
	}
}

// CancelAniList drops the pending AniList sign-in and stops its page.
func (s *Service) CancelAniList() {
	s.signInMu.Lock()
	defer s.signInMu.Unlock()
	if s.aniIn != nil {
		s.aniIn.close()
		s.aniIn = nil
	}
}

func (in *aniListSignIn) close() {
	in.once.Do(func() {
		in.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = in.server.Shutdown(ctx)
	})
}

func (s *Service) keepAniList(ctx context.Context, profileID uint64, token string) error {
	user, err := s.anilist.Viewer(ctx, token)
	if err != nil {
		return wrap("AniList account", err)
	}
	db := s.open()
	if err := db.SetTrackingTokenOwner(profileID, true); err != nil {
		return err
	}
	if err := s.keychain.Set(anilistKey(profileID), token); err != nil {
		return err
	}
	var expires int64
	if at := anilist.Expiry(token); !at.IsZero() {
		expires = at.UnixMilli()
	}
	return db.UpdateTracking(profileID, func(t *store.Tracking) error {
		t.AniList = &store.AniListLink{UserID: user.ID, User: user.Name, Expires: expires}
		return nil
	})
}

// DisconnectAniList removes profile id's AniList token and connection.
// AniList has no revoke call: the user can remove Peli from their AniList
// settings too.
func (s *Service) DisconnectAniList(profileID uint64) (Connections, error) {
	return s.disconnect(profileID, ServiceAniList)
}

// aniListHandler serves the redirect page, and takes the token its script
// posts back from the same origin.
func aniListHandler(tokens chan<- string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /anilist", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		_, _ = io.WriteString(w, redirectPage)
	})
	mux.HandleFunc("POST /anilist/token", func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://127.0.0.1:"+fmt.Sprint(AniListPort) {
			http.Error(w, "wrong origin", http.StatusForbidden)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		token := strings.TrimSpace(string(data))
		if err != nil || token == "" || strings.ContainsAny(token, " \n\r\t") {
			http.Error(w, "no token", http.StatusBadRequest)
			return
		}
		select {
		case tokens <- token:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

// The page AniList redirects to: it posts the fragment's token back and
// says what happened. No token in any URL Peli logs.
var redirectPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>` + html.EscapeString("Peli · AniList") + `</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#eee}main{max-width:28rem;padding:2rem;text-align:center}@media(prefers-color-scheme:light){body{background:#f7f7f8;color:#111}}</style>
</head><body><main><h1 id="t">Connecting to Peli…</h1><p id="d"></p></main>
<script>
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("access_token");
history.replaceState(null, "", location.pathname);
const say = (t, d) => { document.getElementById("t").textContent = t; document.getElementById("d").textContent = d; };
if (!token) {
  say("AniList didn’t connect", "Go back to Peli and try again.");
} else {
  fetch("/anilist/token", { method: "POST", body: token })
    .then((r) => { if (!r.ok) throw r; say("AniList is connected", "You can close this tab and go back to Peli."); })
    .catch(() => say("AniList didn’t connect", "Go back to Peli and try again."));
}
</script></body></html>`
