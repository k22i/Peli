package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/animelist"
	"github.com/k22i/Sinag/internal/player"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/simkl"
	"github.com/k22i/Sinag/internal/simkl/simkltest"
	"github.com/k22i/Sinag/internal/store"
)

func ptr(n int) *int { return &n }

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type memKeychain struct {
	mu    sync.Mutex
	items map[string]string
}

func (k *memKeychain) Get(key string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.items[key]
	if !ok {
		return "", secrets.ErrNotFound
	}
	return v, nil
}

func (k *memKeychain) Set(key, value string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[key] = value
	return nil
}

func (k *memKeychain) Delete(key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, key)
	return nil
}

// fakeAniList answers the few queries Sinag sends, for one list.
type fakeAniList struct {
	*httptest.Server
	mu      sync.Mutex
	entries map[int]*anilist.Entry
	saved   []string
}

func newFakeAniList(t *testing.T) *fakeAniList {
	f := &fakeAniList{entries: map[int]*anilist.Entry{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &req)
		if r.Header.Get("Authorization") != "Bearer ani-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"data":null,"errors":[{"message":"Invalid token","status":401}]}`)
			return
		}
		var answer any
		switch {
		case strings.Contains(req.Query, "Viewer"):
			answer = map[string]any{"Viewer": map[string]any{"id": 7, "name": "kev"}}
		case strings.Contains(req.Query, "SaveMediaListEntry"):
			id := int(req.Variables["id"].(float64))
			progress := int(req.Variables["progress"].(float64))
			status := req.Variables["status"].(string)
			f.entries[id] = &anilist.Entry{Status: status, Progress: progress}
			f.saved = append(f.saved, fmt.Sprintf("%d:%d:%s", id, progress, status))
			answer = map[string]any{"SaveMediaListEntry": map[string]any{"id": 1}}
		case strings.Contains(req.Query, "MediaListCollection"):
			answer = map[string]any{"MediaListCollection": map[string]any{"lists": []any{map[string]any{"entries": []any{
				map[string]any{"status": "CURRENT", "progress": 2, "updatedAt": 1_800_000_000,
					"completedAt": map[string]any{}, "media": map[string]any{"id": 154587, "episodes": 28, "format": "TV"}},
			}}}}}
		case strings.Contains(req.Query, "Media("):
			id := int(req.Variables["id"].(float64))
			answer = map[string]any{"Media": map[string]any{"id": id, "episodes": 28, "format": "TV", "mediaListEntry": f.entries[id]}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": answer})
	}))
	t.Cleanup(f.Close)
	return f
}

type fixture struct {
	db      *store.Store
	profile store.Profile
	keys    *memKeychain
	simkl   *simkltest.Server
	ani     *fakeAniList
	s       *Service
	clock   time.Time
}

// Frieren's first season: Kitsu 46474, AniList 154587, on IMDb as
// tt22248376 season 1.
var frieren = animelist.Entry{AniList: 154587, Kitsu: 46474, MAL: 52991, IMDb: []string{"tt22248376"}, Season: ptr(1), Type: "TV"}

func setup(t *testing.T) *fixture {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "sinag.db"))
	check(t, err)
	t.Cleanup(func() { db.Close() })
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: ptr(1)})
	check(t, err)
	f := &fixture{db: db, profile: profile, keys: &memKeychain{items: map[string]string{}}, simkl: simkltest.New(t), ani: newFakeAniList(t)}
	f.clock = time.UnixMilli(1_800_000_000_000)
	f.s = NewService(Config{
		Simkl:           simkl.New(f.simkl.URL, simkltest.ClientID, "1.0"),
		AniList:         anilist.New(f.ani.URL, "1.0"),
		AniListClientID: "ani-client",
		Anime:           animelist.FromEntries([]animelist.Entry{frieren}),
		Keychain:        f.keys,
		Open:            func() *store.Store { return db },
	})
	f.s.now = func() time.Time { return f.clock }
	f.s.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	f.s.connected = func(uint64) {}
	return f
}

// connectSimkl signs in through the fake's device flow.
func (f *fixture) connectSimkl(t *testing.T) {
	t.Helper()
	code, err := f.s.StartSimkl(context.Background(), f.profile.ID)
	check(t, err)
	if code.Code != "BDWP-HQPK" || !strings.Contains(code.URL, "user_code=BDWP-HQPK") {
		t.Fatalf("code = %+v", code)
	}
	f.simkl.Set(func(s *simkltest.Server) { s.Approved = true })
	got, err := f.s.WaitSimkl(context.Background())
	check(t, err)
	if got.Simkl == nil || got.Simkl.User != "kevin" {
		t.Fatalf("connections = %+v", got)
	}
}

func (f *fixture) connectAniList(t *testing.T) {
	t.Helper()
	check(t, f.s.keepAniList(context.Background(), f.profile.ID, "ani-token"))
}

func (f *fixture) episode() player.Watching {
	return player.Watching{
		ProfileID: f.profile.ID, ContentID: "tt0903747", ContentType: "series", VideoID: "tt0903747:2:4",
		Season: ptr(2), Episode: ptr(4), Title: "Down", Name: "Breaking Bad", Year: 2008,
		IDs: map[string]string{"tmdb": "1396", "tvdb": "81189", "bogus": "x"},
	}
}

func (f *fixture) report(w player.Watching, why string, at float64) {
	f.s.scrobbler.handle(context.Background(), player.Report{Watching: w, Position: at, Duration: 2800, Why: why})
}

func actions(calls []simkltest.Scrobble) string {
	var out []string
	for _, c := range calls {
		out = append(out, fmt.Sprintf("%s@%g/%d", c.Action, c.Progress, c.MinProgress))
	}
	return strings.Join(out, " ")
}

func TestConnectSimkl(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	if f.keys.items[simklAccessKey(f.profile.ID)] == "" || f.keys.items[simklRefreshKey(f.profile.ID)] == "" {
		t.Fatalf("keychain = %v", f.keys.items)
	}
	// Disconnecting revokes the grant and forgets the tokens.
	got, err := f.s.DisconnectSimkl(context.Background(), f.profile.ID)
	check(t, err)
	if got.Simkl != nil || len(f.keys.items) != 0 || f.simkl.Access != "" {
		t.Fatalf("after disconnect: %+v, keychain %v, fake access %q", got, f.keys.items, f.simkl.Access)
	}
}

func TestReadOnlyGrantIsRefused(t *testing.T) {
	f := setup(t)
	f.simkl.Set(func(s *simkltest.Server) { s.Scope = "media:read" })
	_, err := f.s.StartSimkl(context.Background(), f.profile.ID)
	check(t, err)
	f.simkl.Set(func(s *simkltest.Server) { s.Approved = true })
	if _, err := f.s.WaitSimkl(context.Background()); !errors.Is(err, simkl.ErrReadOnly) {
		t.Fatalf("err = %v, want read-only", err)
	}
}

func TestKidsProfilesDontConnect(t *testing.T) {
	f := setup(t)
	check(t, f.db.SetKids(f.profile.ID, true))
	if _, err := f.s.StartSimkl(context.Background(), f.profile.ID); !errors.Is(err, ErrKidsProfile) {
		t.Fatalf("SIMKL: err = %v", err)
	}
	if _, err := f.s.StartAniList(context.Background(), f.profile.ID); !errors.Is(err, ErrKidsProfile) {
		t.Fatalf("AniList: err = %v", err)
	}
}

func TestScrobblesFollowThePlayer(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	w := f.episode()
	f.report(w, player.ReportStarted, 0)
	f.report(w, player.ReportPlaying, 280)
	f.report(w, player.ReportSeeked, 1400) // no call: the next one carries it
	f.report(w, player.ReportPaused, 1400)
	f.report(w, player.ReportResumed, 1400)
	f.report(w, player.ReportStopped, 2660)
	want := "start@0/90 pause@50/90 start@50/90 stop@95/90"
	if got := actions(f.simkl.Calls()); got != want {
		t.Fatalf("scrobbles = %s, want %s", got, want)
	}
	body := f.simkl.Calls()[0].Body
	show, _ := json.Marshal(body["show"])
	episode, _ := json.Marshal(body["episode"])
	if string(show) != `{"ids":{"imdb":"tt0903747","tmdb":"1396","tvdb":"81189"},"title":"Breaking Bad","year":2008}` ||
		string(episode) != `{"number":4,"season":2}` {
		t.Fatalf("body = show %s, episode %s", show, episode)
	}
}

func TestMissedResumeStartsAgain(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	w := f.episode()
	f.report(w, player.ReportStarted, 0)
	f.report(w, player.ReportPaused, 280)
	// The player was paused and played within one report: the next periodic
	// report finds it playing.
	f.report(w, player.ReportPlaying, 560)
	if got := actions(f.simkl.Calls()); got != "start@0/90 pause@10/90 start@20/90" {
		t.Fatalf("scrobbles = %s", got)
	}
}

func TestAnimeScrobblesWithItsOwnIDs(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	w := player.Watching{
		ProfileID: f.profile.ID, ContentID: "kitsu:46474", ContentType: "series", VideoID: "kitsu:46474:3",
		Season: ptr(1), Episode: ptr(3), Name: "Sousou no Frieren", IDs: map[string]string{"imdb": "tt22248376"},
	}
	f.report(w, player.ReportStarted, 0)
	body := f.simkl.Calls()[0].Body
	anime, _ := json.Marshal(body["anime"])
	episode, _ := json.Marshal(body["episode"])
	// No IMDb id: it names the whole series, and episode 3 counts within
	// the cour.
	if string(anime) != `{"ids":{"kitsu":"46474"},"title":"Sousou no Frieren"}` || string(episode) != `{"number":3}` {
		t.Fatalf("body = anime %s, episode %s", anime, episode)
	}

	// With anime off (kept on AniList instead), anime isn't scrobbled,
	// whether its id is Kitsu's or an IMDb id the anime list knows.
	settings := store.DefaultProfileSettings()
	settings.SimklAnime = false
	check(t, f.db.SaveProfileSettings(f.profile.ID, settings))
	f.report(w, player.ReportStopped, 2700)
	cinemeta := player.Watching{ProfileID: f.profile.ID, ContentID: "tt22248376", ContentType: "series", VideoID: "tt22248376:1:3", Season: ptr(1), Episode: ptr(3)}
	f.report(cinemeta, player.ReportStarted, 0)
	if n := len(f.simkl.Calls()); n != 1 {
		t.Fatalf("%d scrobbles, want 1: %s", n, actions(f.simkl.Calls()))
	}
}

func TestScrobbleOff(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	settings := store.DefaultProfileSettings()
	settings.SimklScrobble = false
	check(t, f.db.SaveProfileSettings(f.profile.ID, settings))
	f.report(f.episode(), player.ReportStarted, 0)
	f.report(f.episode(), player.ReportStopped, 2700)
	if calls := f.simkl.Calls(); len(calls) != 0 {
		t.Fatalf("scrobbles = %s", actions(calls))
	}
}

func TestOfflineWatchIsKeptForTheHistory(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	w := f.episode()
	f.report(w, player.ReportStarted, 0)
	f.simkl.Set(func(s *simkltest.Server) { s.Down = true })
	// Below 90 % only a resume point is lost; at 95 % the watch is kept.
	f.report(w, player.ReportStopped, 1000)
	f.report(w, player.ReportStarted, 1000)
	f.report(w, player.ReportStopped, 2660)
	jobs, err := f.db.TrackingJobs(f.profile.ID)
	check(t, err)
	if len(jobs) != 1 || jobs[0].Service != ServiceSimkl {
		t.Fatalf("jobs = %+v", jobs)
	}

	// Not due yet; then due, and SIMKL is still down: it backs off.
	if wait := f.s.sendJobs(context.Background()); wait != retryFirst {
		t.Fatalf("wait = %s", wait)
	}
	f.clock = f.clock.Add(retryFirst)
	if wait := f.s.sendJobs(context.Background()); wait != 2*retryFirst {
		t.Fatalf("wait after a failure = %s", wait)
	}

	f.simkl.Set(func(s *simkltest.Server) { s.Down = false })
	f.clock = f.clock.Add(2 * retryFirst)
	f.s.sendJobs(context.Background())
	history := f.simkl.Histories()
	if len(history) != 1 {
		t.Fatalf("history = %v", history)
	}
	sent, _ := json.Marshal(history[0])
	want := `{"shows":[{"ids":{"imdb":"tt0903747","tmdb":"1396","tvdb":"81189"},"seasons":[{"episodes":[{"number":4,"watched_at":"2027-01-15T08:00:00Z"}],"number":2}],"title":"Breaking Bad","use_tvdb_anime_seasons":true,"year":2008}]}`
	if string(sent) != want {
		t.Fatalf("history = %s\nwant      %s", sent, want)
	}
	if jobs, _ := f.db.TrackingJobs(f.profile.ID); len(jobs) != 0 {
		t.Fatalf("jobs left = %+v", jobs)
	}
}

func TestAStopSimklFinalizedIsDone(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.simkl.Set(func(s *simkltest.Server) { s.Done = true })
	f.report(f.episode(), player.ReportStopped, 2700)
	if jobs, _ := f.db.TrackingJobs(f.profile.ID); len(jobs) != 0 {
		t.Fatalf("a 409 was kept: %+v", jobs)
	}
}

func TestRefusedTokenIsRefreshedOnce(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	// Another grant's refresh cut this token off.
	f.simkl.Set(func(s *simkltest.Server) { s.Access = "simkl_at_elsewhere" })
	f.report(f.episode(), player.ReportStarted, 0)
	if f.simkl.Refreshes != 1 || len(f.simkl.Calls()) != 1 {
		t.Fatalf("refreshes = %d, scrobbles = %s", f.simkl.Refreshes, actions(f.simkl.Calls()))
	}
	// The refresh token stopped working: connect again.
	f.simkl.Set(func(s *simkltest.Server) { s.Access, s.Refresh = "x", "y" })
	f.report(f.episode(), player.ReportPaused, 100)
	status, err := f.s.Status(f.profile.ID)
	check(t, err)
	if !status.Simkl.NeedsReconnect {
		t.Fatalf("status = %+v", status.Simkl)
	}
}

func TestTokenIsRefreshedBeforeItExpires(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.clock = f.clock.Add(6*24*time.Hour + time.Hour)
	f.report(f.episode(), player.ReportStarted, 0)
	if f.simkl.Refreshes != 1 {
		t.Fatalf("refreshes = %d", f.simkl.Refreshes)
	}
}

func TestImportSimkl(t *testing.T) {
	f := setup(t)
	// A rewatch under way, newer than the SIMKL watch, keeps its progress.
	_, err := f.db.SaveProgress(f.profile.ID, store.Progress{ContentID: "tt0111161", ContentType: "movie", VideoID: "tt0111161", Position: 600_000, Duration: 8_520_000, LastWatched: f.clock.UnixMilli()})
	check(t, err)
	f.simkl.Set(func(s *simkltest.Server) {
		s.Activities = map[string]any{"all": "2026-10-30T10:00:00Z",
			"movies": map[string]any{"all": "2026-10-30T10:00:00Z"}, "tv_shows": map[string]any{"all": "2026-10-29T10:00:00Z"},
			"anime": map[string]any{"all": "2026-10-28T10:00:00Z"}}
		s.Library["movies"] = map[string]any{"movies": []any{
			map[string]any{"status": "completed", "last_watched_at": "2019-05-01T20:00:00Z",
				"movie": map[string]any{"title": "The Shawshank Redemption", "ids": map[string]any{"simkl": 1, "imdb": "tt0111161"}}},
			map[string]any{"status": "plantowatch", "movie": map[string]any{"title": "Later", "ids": map[string]any{"imdb": "tt1"}}},
		}}
		s.Library["shows"] = map[string]any{"shows": []any{
			map[string]any{"status": "watching", "show": map[string]any{"title": "Breaking Bad", "ids": map[string]any{"imdb": "tt0903747"}},
				"seasons": []any{map[string]any{"number": 1, "episodes": []any{
					map[string]any{"number": 1, "watched_at": "2020-01-01T00:00:00Z"},
					map[string]any{"number": 2, "watched_at": "2020-01-02T00:00:00Z"}}}}},
		}}
		s.Library["anime"] = map[string]any{"anime": []any{
			map[string]any{"status": "watching", "anime_type": "tv", "show": map[string]any{"title": "Frieren", "ids": map[string]any{"mal": "52991", "imdb": "tt22248376"}},
				"seasons": []any{map[string]any{"number": 1, "episodes": []any{
					map[string]any{"number": 1, "watched_at": "2024-01-01T00:00:00Z", "tvdb": map[string]any{"season": 1, "episode": 1}}}}}},
		}}
	})
	f.connectSimkl(t)
	got, err := f.s.Import(context.Background(), f.profile.ID)
	check(t, err)
	marks, err := f.db.Watched(f.profile.ID)
	check(t, err)
	var names []string
	for _, m := range marks {
		name := m.ContentID
		if m.Season != nil {
			name += fmt.Sprintf(":%d:%d", *m.Season, *m.Episode)
		}
		names = append(names, name)
	}
	// Anime goes to its Kitsu id, which the anime addons use.
	if strings.Join(names, " ") != "kitsu:46474:1:1 tt0111161 tt0903747:1:1 tt0903747:1:2" || got.Simkl != 4 {
		t.Fatalf("marks = %v (imported %+v)", names, got)
	}
	if progress, _ := f.db.TitleProgress(f.profile.ID, "tt0111161"); len(progress) != 1 {
		t.Fatalf("the rewatch's progress went: %+v", progress)
	}

	// Next time only what changed after the last import is asked for, and
	// nothing when nothing did.
	f.simkl.Set(func(s *simkltest.Server) { s.LibraryCalls = nil })
	_, err = f.s.Import(context.Background(), f.profile.ID)
	check(t, err)
	if len(f.simkl.LibraryCalls) != 0 {
		t.Fatalf("unchanged lists pulled: %v", f.simkl.LibraryCalls)
	}
	f.simkl.Set(func(s *simkltest.Server) {
		s.Activities = map[string]any{"all": "2026-10-31T10:00:00Z", "movies": map[string]any{"all": "2026-10-31T10:00:00Z"},
			"tv_shows": map[string]any{"all": "2026-10-29T10:00:00Z"}, "anime": map[string]any{"all": "2026-10-28T10:00:00Z"}}
	})
	_, err = f.s.Import(context.Background(), f.profile.ID)
	check(t, err)
	if strings.Join(f.simkl.LibraryCalls, " ") != "movies?2026-10-30T10:00:00Z" {
		t.Fatalf("pulled %v", f.simkl.LibraryCalls)
	}
}

func TestAniListProgressOnWatched(t *testing.T) {
	f := setup(t)
	f.connectAniList(t)
	w := player.Watching{ProfileID: f.profile.ID, ContentID: "tt22248376", ContentType: "series", VideoID: "tt22248376:1:3", Season: ptr(1), Episode: ptr(3)}
	f.report(w, player.ReportPlaying, 1000)
	f.report(w, player.ReportPlaying, 2600) // 92 %: watched
	f.report(w, player.ReportStopped, 2700) // once per file
	if strings.Join(f.ani.saved, " ") != "154587:3:CURRENT" {
		t.Fatalf("saved = %v", f.ani.saved)
	}
	// An earlier episode doesn't move the list back.
	w.VideoID, w.Episode = "tt22248376:1:2", ptr(2)
	f.report(w, player.ReportEnded, 2800)
	if len(f.ani.saved) != 1 {
		t.Fatalf("saved = %v", f.ani.saved)
	}
	// The last episode completes it.
	w.VideoID, w.Episode = "tt22248376:1:28", ptr(28)
	f.report(w, player.ReportEnded, 2800)
	if f.ani.saved[len(f.ani.saved)-1] != "154587:28:COMPLETED" {
		t.Fatalf("saved = %v", f.ani.saved)
	}
}

func TestAniListImport(t *testing.T) {
	f := setup(t)
	f.connectAniList(t)
	got, err := f.s.Import(context.Background(), f.profile.ID)
	check(t, err)
	marks, err := f.db.TitleWatched(f.profile.ID, "kitsu:46474")
	check(t, err)
	if got.AniList != 2 || len(marks) != 2 {
		t.Fatalf("imported %+v, marks %+v", got, marks)
	}
	// Entries not updated since aren't read again.
	got, err = f.s.Import(context.Background(), f.profile.ID)
	check(t, err)
	if got.AniList != 0 {
		t.Fatalf("second import = %+v", got)
	}
}

func TestDeletedProfilesTokensAreForgotten(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	check(t, f.db.DeleteProfile(f.profile.ID))
	f.s.forgetDeleted()
	if len(f.keys.items) != 0 {
		t.Fatalf("keychain = %v", f.keys.items)
	}
}

func TestMarshalError(t *testing.T) {
	for err, code := range map[error]string{
		ErrKidsProfile:                         CodeKidsProfile,
		fmt.Errorf("x: %w", simkl.ErrCodeGone): CodeSignInExpired,
		&simkl.RateLimited{}:                   CodeRateLimited,
		simkl.ErrReadOnly:                      CodeReadOnly,
		errPortInUse:                           CodePortInUse,
	} {
		if got := string(MarshalError(err)); got != `{"code":"`+code+`"}` {
			t.Errorf("MarshalError(%v) = %s", err, got)
		}
	}
	if MarshalError(errors.New("other")) != nil {
		t.Error("an unknown error got a code")
	}
}
