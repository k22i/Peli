package livetv

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// A source's stream URLs, with the username and password an Xtream link
// carries. The tests check they reach Stream and nowhere else.
var sourceStreamURLs = []string{
	"https://stream.example/live/kevin/s3cret/1.ts",
	"https://stream.example/live/kevin/s3cret/2.ts",
	"https://stream.example/live/kevin/s3cret/3.ts",
}

// fakeKeychain is the OS keychain, as a map.
type fakeKeychain struct {
	mu    sync.Mutex
	items map[string]string
}

func (k *fakeKeychain) Get(key string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	value, ok := k.items[key]
	if !ok {
		return "", secrets.ErrNotFound
	}
	return value, nil
}

func (k *fakeKeychain) Set(key, value string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[key] = value
	return nil
}

func (k *fakeKeychain) Delete(key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, key)
	return nil
}

// len is how many URLs the keychain holds.
func (k *fakeKeychain) len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.items)
}

// fakeProvider stands in for an IPTV provider: a playlist, a gzipped guide, a
// missing file and a playlist over the cap, with a switch that makes the
// playlist fail.
type fakeProvider struct {
	mu       sync.Mutex
	tvg      string // the url-tvg the playlist names, "" for none
	status   int    // the playlist's status, 0 for 200
	guide    []byte
	requests int
}

func (p *fakeProvider) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.requests++
		tvg, status, guide := p.tvg, p.status, p.guide
		p.mu.Unlock()
		switch r.URL.Path {
		case "/list.m3u":
			if status != 0 {
				w.WriteHeader(status)
				return
			}
			io.WriteString(w, p.playlistText(tvg))
		case "/guide.xml.gz":
			w.Header().Set("Content-Type", "application/gzip")
			w.Write(guide)
		case "/big.m3u":
			// Over the 50 MiB cap, in pieces and in short lines, so a reader
			// trips the cap rather than a line-length limit.
			line := append(bytes.Repeat([]byte("#"), 63), '\n')
			chunk := bytes.Repeat(line, 1<<14)
			for range 51 {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		default:
			http.NotFound(w, r)
		}
	}
}

// playlistText is three channels with tvg-ids, two groups, and one that names
// its own user agent.
func (p *fakeProvider) playlistText(tvg string) string {
	header := "#EXTM3U"
	if tvg != "" {
		header += ` url-tvg="` + tvg + `"`
	}
	return header + "\n" +
		`#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="https://logo.example/bbc1.png" group-title="News",BBC One HD` + "\n" +
		"#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Peli test)\n" +
		sourceStreamURLs[0] + "\n" +
		`#EXTINF:-1 tvg-id="itv1.uk" tvg-name="ITV 1" group-title="News",ITV 1` + "\n" +
		sourceStreamURLs[1] + "\n" +
		`#EXTINF:-1 tvg-id="c4.uk" tvg-name="Channel 4" group-title="Films",Channel 4` + "\n" +
		sourceStreamURLs[2] + "\n"
}

// guideGz is the guide around a fixed clock: one BBC One programme that has
// just ended, one on now and one next, plus a programme on each other
// channel.
func (p *fakeProvider) guideGz(t *testing.T, clock time.Time) []byte {
	t.Helper()
	stamp := func(t time.Time) string { return t.UTC().Format("20060102150405 -0700") }
	programme := func(channel, title string, start, stop time.Time) string {
		return fmt.Sprintf("  <programme start=%q stop=%q channel=%q>\n"+
			"    <title lang=\"en\">%s</title>\n"+
			"    <desc lang=\"en\">%s, on %s.</desc>\n"+
			"    <category lang=\"en\">News</category>\n"+
			"  </programme>\n",
			stamp(start), stamp(stop), channel, title, title, channel)
	}
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<tv generator-info-name=\"peli-test\">\n")
	for _, channel := range []struct{ id, name string }{
		{"bbc1.uk", "BBC One"},
		{"itv1.uk", "ITV 1"},
		{"c4.uk", "Channel 4"},
	} {
		fmt.Fprintf(&b, "  <channel id=%q><display-name>%s</display-name></channel>\n", channel.id, channel.name)
	}
	b.WriteString(programme("bbc1.uk", "Breakfast", clock.Add(-90*time.Minute), clock))
	b.WriteString(programme("bbc1.uk", "News at Nine", clock, clock.Add(time.Hour)))
	b.WriteString(programme("bbc1.uk", "Weather", clock.Add(time.Hour), clock.Add(2*time.Hour)))
	b.WriteString(programme("itv1.uk", "ITV Morning", clock.Add(-30*time.Minute), clock.Add(30*time.Minute)))
	b.WriteString(programme("c4.uk", "Later Film", clock.Add(2*time.Hour), clock.Add(3*time.Hour)))
	b.WriteString("</tv>\n")
	var out bytes.Buffer
	gzipWriter := gzip.NewWriter(&out)
	if _, err := io.WriteString(gzipWriter, b.String()); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// set makes the playlist fail, or work again, and names a guide.
func (p *fakeProvider) set(status int, tvg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status, p.tvg = status, tvg
}

// reset forgets what has been asked for.
func (p *fakeProvider) reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.requests = 0
}

// counted is how many requests the provider has had.
func (p *fakeProvider) counted() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requests
}

// serviceFixture is a store with one profile, a keychain, a cache folder and a
// service on them, with a clock the test moves.
type serviceFixture struct {
	db       *store.Store
	profile  store.Profile
	keys     *fakeKeychain
	provider *fakeProvider
	srv      *httptest.Server
	cacheDir string
	s        *Service

	mu     sync.Mutex
	clock  time.Time
	events []string
}

func newServiceFixture(t *testing.T) *serviceFixture {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "peli.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	// A kids flag needs a Nuvio profile with a PIN to leave it with.
	nuvioIndex := 1
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: &nuvioIndex, PinEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	f := &serviceFixture{
		db:       db,
		profile:  profile,
		keys:     &fakeKeychain{items: map[string]string{}},
		provider: &fakeProvider{},
		cacheDir: t.TempDir(),
		clock:    time.UnixMilli(1_800_000_000_000),
	}
	f.provider.guide = f.provider.guideGz(t, f.clock)
	f.srv = httptest.NewServer(f.provider.handler())
	t.Cleanup(f.srv.Close)
	f.s = f.service()
	return f
}

// service is another Service on the same store and cache, with the test's
// clock and a recorder for what it emits.
func (f *serviceFixture) service() *Service {
	s := NewService(Config{
		Open:     func() *store.Store { return f.db },
		Keychain: f.keys,
		CacheDir: f.cacheDir,
		Version:  "test",
	})
	s.now = f.now
	s.emit = f.emit
	return s
}

// now is the test's clock: what counts as stale is driven by it.
func (f *serviceFixture) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clock
}

func (f *serviceFixture) advance(by time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clock = f.clock.Add(by)
}

func (f *serviceFixture) emit(name string, data any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if updated, ok := data.(Updated); ok {
		f.events = append(f.events, name+" "+updated.SourceID)
		return
	}
	f.events = append(f.events, name)
}

// eventsSoFar is what the service has emitted.
func (f *serviceFixture) eventsSoFar() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

// ok fails the test on an error.
func (f *serviceFixture) ok(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// codeIs checks an error is one of ours with this code, and that nothing in
// its text names a URL: they carry credentials.
func (f *serviceFixture) codeIs(t *testing.T, err error, code string) {
	t.Helper()
	var refusal *Error
	if !errors.As(err, &refusal) || refusal.Code != code {
		t.Fatalf("error = %v, want code %q", err, code)
	}
	if strings.Contains(err.Error(), f.srv.URL) {
		t.Fatalf("error names a URL: %v", err)
	}
}

// add makes a source with the playlist and guide URLs and waits for its first
// refresh.
func (f *serviceFixture) add(t *testing.T) Source {
	t.Helper()
	src, err := f.s.AddSource(SourceInput{
		ProfileID:   f.profile.ID,
		Name:        "Home",
		PlaylistURL: f.srv.URL + "/list.m3u",
		GuideURL:    f.srv.URL + "/guide.xml.gz",
	})
	f.ok(t, err)
	return f.waitIdle(t, src.ID)
}

// waitIdle waits for a source's refresh to finish, up to 5 s.
func (f *serviceFixture) waitIdle(t *testing.T, id string) Source {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		sources, err := f.s.Sources(f.profile.ID)
		f.ok(t, err)
		for _, src := range sources {
			if src.ID != id {
				continue
			}
			if !src.Refreshing {
				return src
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("livetv: the refresh never finished")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// channelWithTvgID finds a channel's id by its tvg-id, which the guide matches on.
func channelWithTvgID(t *testing.T, channels []Channel, tvgID string) string {
	t.Helper()
	for _, channel := range channels {
		if channel.TvgID == tvgID {
			return channel.ID
		}
	}
	t.Fatalf("no channel with tvg-id %q", tvgID)
	return ""
}

func TestAddSourceFetchesBoth(t *testing.T) {
	f := newServiceFixture(t)
	src, err := f.s.AddSource(SourceInput{
		ProfileID:   f.profile.ID,
		Name:        "Home",
		PlaylistURL: f.srv.URL + "/list.m3u",
		GuideURL:    f.srv.URL + "/guide.xml.gz",
	})
	f.ok(t, err)
	if !validID(src.ID) {
		t.Fatalf("id = %q, want 16 lowercase hex characters", src.ID)
	}
	if !src.Refreshing {
		t.Fatal("a new source is not refreshing")
	}
	done := f.waitIdle(t, src.ID)
	if done.Name != "Home" || done.ProfileID != f.profile.ID {
		t.Fatalf("source = %+v", done)
	}
	if done.Channels != 3 || done.GuideChannels != 3 || done.Programmes != 5 {
		t.Fatalf("%d channels, %d guide channels, %d programmes, want 3, 3, 5",
			done.Channels, done.GuideChannels, done.Programmes)
	}
	if !done.HasGuide || done.GuideFromPlaylist {
		t.Fatalf("hasGuide %v, guideFromPlaylist %v", done.HasGuide, done.GuideFromPlaylist)
	}
	at := f.now().UnixMilli()
	if done.PlaylistAt != at || done.GuideAt != at {
		t.Fatalf("playlistAt %d, guideAt %d, want %d", done.PlaylistAt, done.GuideAt, at)
	}
	if done.PlaylistError != "" || done.GuideError != "" {
		t.Fatalf("playlistError %q, guideError %q", done.PlaylistError, done.GuideError)
	}
	if got, err := f.keys.Get(playlistKey(src.ID)); err != nil || got != f.srv.URL+"/list.m3u" {
		t.Fatalf("the keychain's playlist = %q, %v", got, err)
	}
	if got, err := f.keys.Get(guideKey(src.ID)); err != nil || got != f.srv.URL+"/guide.xml.gz" {
		t.Fatalf("the keychain's guide = %q, %v", got, err)
	}
	// The store keeps no URL: it would be a file the provider's credentials
	// sit in.
	rec, err := f.db.LiveSource(src.ID)
	f.ok(t, err)
	data, err := json.Marshal(rec)
	f.ok(t, err)
	if strings.Contains(string(data), "http") {
		t.Fatalf("the store's record holds a URL: %s", data)
	}
	// The add's event, then the refresh's start and end.
	want := []string{EventUpdated + " " + src.ID, EventUpdated + " " + src.ID, EventUpdated + " " + src.ID}
	if got := f.eventsSoFar(); !slices.Equal(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	if len(channels) != 3 {
		t.Fatalf("%d channels, want 3", len(channels))
	}
	for i, channel := range channels {
		if channel.Number != i+1 {
			t.Fatalf("channel %d has number %d", i, channel.Number)
		}
		if channel.SourceID != src.ID {
			t.Fatalf("channel %d belongs to %q", i, channel.SourceID)
		}
	}
}

func TestGuideFromPlaylist(t *testing.T) {
	f := newServiceFixture(t)
	// A source with no guide URL of its own takes the playlist's url-tvg.
	f.provider.set(0, f.srv.URL+"/guide.xml.gz")
	src, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: f.srv.URL + "/list.m3u"})
	f.ok(t, err)
	done := f.waitIdle(t, src.ID)
	if !done.HasGuide || !done.GuideFromPlaylist {
		t.Fatalf("hasGuide %v, guideFromPlaylist %v", done.HasGuide, done.GuideFromPlaylist)
	}
	if done.GuideChannels != 3 || done.Programmes != 5 || done.GuideAt == 0 {
		t.Fatalf("%d guide channels, %d programmes, guideAt %d",
			done.GuideChannels, done.Programmes, done.GuideAt)
	}
	// No name was given, so the URL's host stands in.
	if done.Name != "127.0.0.1" {
		t.Fatalf("name = %q, want the playlist's host", done.Name)
	}
}

func TestNowNextAndGuide(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	bbc := channelWithTvgID(t, channels, "bbc1.uk")
	unknown := src.ID + ":ffffffffffff"

	nowNext, err := f.s.NowNext(f.profile.ID, []string{bbc, unknown})
	f.ok(t, err)
	if len(nowNext) != 2 || nowNext[0].ChannelID != bbc || nowNext[1].ChannelID != unknown {
		t.Fatalf("now next = %+v", nowNext)
	}
	if nowNext[0].Now == nil || nowNext[0].Now.Title != "News at Nine" {
		t.Fatalf("now = %+v, want the programme the clock starts", nowNext[0].Now)
	}
	if nowNext[0].Next == nil || nowNext[0].Next.Title != "Weather" {
		t.Fatalf("next = %+v, want the programme after it", nowNext[0].Next)
	}
	if nowNext[1].Now != nil || nowNext[1].Next != nil {
		t.Fatalf("an unknown channel has a programme: %+v", nowNext[1])
	}
	// The programmes are copies: writing to one leaves the cache alone.
	nowNext[0].Now.Title = "changed"
	again, err := f.s.NowNext(f.profile.ID, []string{bbc})
	f.ok(t, err)
	if again[0].Now == nil || again[0].Now.Title != "News at Nine" {
		t.Fatalf("now = %+v, want the cached title", again[0].Now)
	}

	clock := f.now()
	guides, err := f.s.Guide(f.profile.ID, []string{bbc, unknown},
		clock.Add(-2*time.Hour).UnixMilli(), clock.Add(2*time.Hour).UnixMilli())
	f.ok(t, err)
	if len(guides) != 2 || guides[0].ChannelID != bbc || guides[1].ChannelID != unknown {
		t.Fatalf("guides = %+v", guides)
	}
	if len(guides[0].Programmes) != 3 {
		t.Fatalf("%d programmes, want the three the window covers", len(guides[0].Programmes))
	}
	if guides[1].Programmes == nil || len(guides[1].Programmes) != 0 {
		t.Fatalf("an unknown channel's programmes = %v, want an empty list", guides[1].Programmes)
	}
	// A narrower window drops the programme that has already ended.
	narrow, err := f.s.Guide(f.profile.ID, []string{bbc},
		clock.Add(30*time.Minute).UnixMilli(), clock.Add(90*time.Minute).UnixMilli())
	f.ok(t, err)
	if len(narrow[0].Programmes) != 2 {
		t.Fatalf("%d programmes, want 2", len(narrow[0].Programmes))
	}
	_, err = f.s.Guide(f.profile.ID, []string{bbc}, clock.UnixMilli(), clock.UnixMilli())
	f.codeIs(t, err, CodeInvalid)
	_, err = f.s.Guide(f.profile.ID, make([]string, maxGuideChannels+1), 0, 1)
	f.codeIs(t, err, CodeInvalid)
}

func TestStream(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	bbc := channelWithTvgID(t, channels, "bbc1.uk")
	itv := channelWithTvgID(t, channels, "itv1.uk")

	stream, err := f.s.Stream(f.profile.ID, bbc)
	f.ok(t, err)
	if stream.URL != sourceStreamURLs[0] {
		t.Fatalf("url = %q, want the entry's stream", stream.URL)
	}
	if stream.Origin != "livetv:"+bbc {
		t.Fatalf("origin = %q", stream.Origin)
	}
	if stream.Headers == nil {
		t.Fatal("headers is nil: the player needs a map to fill")
	}
	if stream.UserAgent != "Mozilla/5.0 (Peli test)" {
		t.Fatalf("user agent = %q, want the entry's", stream.UserAgent)
	}
	recent, err := f.s.Recent(f.profile.ID)
	f.ok(t, err)
	if !slices.Equal(recent, []string{bbc}) {
		t.Fatalf("recent = %v, want just the played channel", recent)
	}

	// The second channel names no user agent of its own.
	second, err := f.s.Stream(f.profile.ID, itv)
	f.ok(t, err)
	if second.UserAgent != "" || second.Headers == nil {
		t.Fatalf("second = %+v", second)
	}
	recent, err = f.s.Recent(f.profile.ID)
	f.ok(t, err)
	if !slices.Equal(recent, []string{itv, bbc}) {
		t.Fatalf("recent = %v, want newest first", recent)
	}

	// Playing one again moves it to the front without repeating it.
	_, err = f.s.Stream(f.profile.ID, bbc)
	f.ok(t, err)
	recent, err = f.s.Recent(f.profile.ID)
	f.ok(t, err)
	if !slices.Equal(recent, []string{bbc, itv}) {
		t.Fatalf("recent = %v, want no duplicates", recent)
	}
}

func TestSetFavourite(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	bbc := channelWithTvgID(t, channels, "bbc1.uk")

	list, err := f.s.SetFavourite(f.profile.ID, bbc, true)
	f.ok(t, err)
	if !slices.Equal(list, []string{bbc}) {
		t.Fatalf("favourites = %v", list)
	}
	// On again changes nothing.
	list, err = f.s.SetFavourite(f.profile.ID, bbc, true)
	f.ok(t, err)
	if len(list) != 1 {
		t.Fatalf("favourites = %v, want one", list)
	}
	list, err = f.s.Favourites(f.profile.ID)
	f.ok(t, err)
	if !slices.Equal(list, []string{bbc}) {
		t.Fatalf("favourites = %v", list)
	}
	list, err = f.s.SetFavourite(f.profile.ID, bbc, false)
	f.ok(t, err)
	if list == nil || len(list) != 0 {
		t.Fatalf("favourites = %v, want an empty list", list)
	}

	_, err = f.s.SetFavourite(f.profile.ID, src.ID+":ffffffffffff", true)
	f.codeIs(t, err, CodeNotFound)
	_, err = f.s.SetFavourite(f.profile.ID, "not-a-channel", true)
	f.codeIs(t, err, CodeNotFound)
}

func TestPlaylistUnreachable(t *testing.T) {
	f := newServiceFixture(t)
	src, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: f.srv.URL + "/missing.m3u"})
	f.ok(t, err)
	done := f.waitIdle(t, src.ID)
	if done.PlaylistError != CodeUnreachable {
		t.Fatalf("playlistError = %q, want %q", done.PlaylistError, CodeUnreachable)
	}
	if done.Channels != 0 || done.PlaylistAt != 0 {
		t.Fatalf("%d channels, playlistAt %d", done.Channels, done.PlaylistAt)
	}
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	if len(channels) != 0 {
		t.Fatalf("%d channels, want none", len(channels))
	}
}

func TestPlaylistTooLarge(t *testing.T) {
	f := newServiceFixture(t)
	src, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: f.srv.URL + "/big.m3u"})
	f.ok(t, err)
	done := f.waitIdle(t, src.ID)
	if done.PlaylistError != CodeTooLarge {
		t.Fatalf("playlistError = %q, want %q", done.PlaylistError, CodeTooLarge)
	}
}

func TestBadURL(t *testing.T) {
	f := newServiceFixture(t)
	for _, playlist := range []string{"ftp://x", "relative/path", ""} {
		_, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: playlist})
		f.codeIs(t, err, CodeInvalid)
	}
	// A bad guide URL is refused too, and leaves nothing behind.
	_, err := f.s.AddSource(SourceInput{
		ProfileID:   f.profile.ID,
		PlaylistURL: f.srv.URL + "/list.m3u",
		GuideURL:    "relative/path",
	})
	f.codeIs(t, err, CodeInvalid)
	if got := f.keys.len(); got != 0 {
		t.Fatalf("the keychain holds %d URLs, want none", got)
	}
}

func TestFileSources(t *testing.T) {
	f := newServiceFixture(t)
	path := filepath.Join(t.TempDir(), "channels.m3u")
	f.ok(t, os.WriteFile(path, []byte(f.provider.playlistText("")), 0o600))

	// A file:// URL.
	src, err := f.s.AddSource(SourceInput{
		ProfileID:   f.profile.ID,
		PlaylistURL: (&url.URL{Scheme: "file", Path: path}).String(),
	})
	f.ok(t, err)
	done := f.waitIdle(t, src.ID)
	if done.Channels != 3 {
		t.Fatalf("%d channels, want 3", done.Channels)
	}
	// No name was given, so the file's base name stands in.
	if done.Name != "channels" {
		t.Fatalf("name = %q, want the file's name", done.Name)
	}

	// A plain absolute path.
	second, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: path})
	f.ok(t, err)
	if done = f.waitIdle(t, second.ID); done.Channels != 3 {
		t.Fatalf("%d channels, want 3", done.Channels)
	}
}

func TestRefreshKeepsChannels(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	// The provider breaks; the last good playlist must survive.
	f.provider.set(http.StatusInternalServerError, "")
	f.ok(t, f.s.Refresh(f.profile.ID, src.ID))
	done := f.waitIdle(t, src.ID)
	if done.PlaylistError != CodeUnreachable {
		t.Fatalf("playlistError = %q, want %q", done.PlaylistError, CodeUnreachable)
	}
	if done.Channels != 3 {
		t.Fatalf("%d channels, want the three the last good fetch found", done.Channels)
	}
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	if len(channels) != 3 {
		t.Fatalf("%d channels, want 3", len(channels))
	}
}

func TestStaleness(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	// Fresh: nothing to do.
	sources, err := f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if len(sources) != 1 || sources[0].Refreshing {
		t.Fatalf("a fresh source is refreshing: %+v", sources)
	}

	// The playlist ages out, and the list starts a refresh of its own.
	f.provider.set(http.StatusInternalServerError, "")
	f.advance(13 * time.Hour)
	sources, err = f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if len(sources) != 1 || !sources[0].Refreshing {
		t.Fatalf("a stale source did not start a refresh: %+v", sources)
	}
	done := f.waitIdle(t, src.ID)
	if done.PlaylistError != CodeUnreachable {
		t.Fatalf("playlistError = %q", done.PlaylistError)
	}

	// A source that has just failed is left alone for 10 min.
	f.advance(5 * time.Minute)
	sources, err = f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if sources[0].Refreshing {
		t.Fatal("a source was retried within 10 min of failing")
	}
	// Past the wait it is due again, and works this time.
	f.provider.set(0, "")
	f.advance(6 * time.Minute)
	sources, err = f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if !sources[0].Refreshing {
		t.Fatalf("a source past the retry window did not refresh: %+v", sources)
	}
	done = f.waitIdle(t, src.ID)
	if done.PlaylistError != "" || done.Channels != 3 {
		t.Fatalf("playlistError = %q, channels = %d", done.PlaylistError, done.Channels)
	}
}

func TestKidsProfile(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	bbc := channelWithTvgID(t, channels, "bbc1.uk")
	f.ok(t, f.db.SetKids(f.profile.ID, true))

	sources, err := f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if sources == nil || len(sources) != 0 {
		t.Fatalf("sources = %v, want an empty list and no error", sources)
	}

	_, err = f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: f.srv.URL + "/list.m3u"})
	f.codeIs(t, err, CodeKids)
	_, err = f.s.Channels(f.profile.ID, "")
	f.codeIs(t, err, CodeKids)
	_, err = f.s.Stream(f.profile.ID, bbc)
	f.codeIs(t, err, CodeKids)
	_, err = f.s.SetFavourite(f.profile.ID, bbc, true)
	f.codeIs(t, err, CodeKids)
}

func TestOtherProfilesSource(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	other, err := f.db.CreateProfile(store.Profile{Name: "Sam"})
	f.ok(t, err)

	_, err = f.s.Channels(other.ID, src.ID)
	f.codeIs(t, err, CodeNotFound)
	f.codeIs(t, f.s.RemoveSource(other.ID, src.ID), CodeNotFound)
	_, err = f.s.Stream(other.ID, channels[0].ID)
	f.codeIs(t, err, CodeNotFound)
	// The source is still the first profile's.
	sources, err := f.s.Sources(other.ID)
	f.ok(t, err)
	if len(sources) != 0 {
		t.Fatalf("another profile's sources = %+v", sources)
	}
}

func TestRemoveSource(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	bbc := channelWithTvgID(t, channels, "bbc1.uk")
	_, err = f.s.Stream(f.profile.ID, bbc)
	f.ok(t, err)
	_, err = f.s.SetFavourite(f.profile.ID, bbc, true)
	f.ok(t, err)
	before := len(f.eventsSoFar())
	f.ok(t, f.s.RemoveSource(f.profile.ID, src.ID))

	for _, key := range []string{playlistKey(src.ID), guideKey(src.ID)} {
		if _, err := f.keys.Get(key); !errors.Is(err, secrets.ErrNotFound) {
			t.Fatalf("the keychain still holds %q: %v", key, err)
		}
	}
	if _, err := os.Stat(filepath.Join(f.cacheDir, src.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the cache folder is still there: %v", err)
	}
	if _, err := f.db.LiveSource(src.ID); !errors.Is(err, store.ErrLiveSourceNotFound) {
		t.Fatalf("the record is still there: %v", err)
	}
	favourites, err := f.s.Favourites(f.profile.ID)
	f.ok(t, err)
	if len(favourites) != 0 {
		t.Fatalf("favourites = %v, want the source's channels gone", favourites)
	}
	recent, err := f.s.Recent(f.profile.ID)
	f.ok(t, err)
	if len(recent) != 0 {
		t.Fatalf("recent = %v, want the source's channels gone", recent)
	}
	sources, err := f.s.Sources(f.profile.ID)
	f.ok(t, err)
	if len(sources) != 0 {
		t.Fatalf("sources = %+v", sources)
	}
	if got := f.eventsSoFar(); len(got) != before+1 {
		t.Fatalf("events = %v, want one more", got)
	}
}

func TestCacheReload(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	before, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	if len(before) != 3 {
		t.Fatalf("%d channels, want 3", len(before))
	}

	// A second Service over the same cache and store needs no network.
	f.provider.reset()
	other := f.service()
	after, err := other.Channels(f.profile.ID, src.ID)
	f.ok(t, err)
	if !slices.Equal(before, after) {
		t.Fatalf("the reloaded channels differ: %+v and %+v", before, after)
	}
	if got := f.provider.counted(); got != 0 {
		t.Fatalf("%d requests for a reload, want none", got)
	}
	// The status came back with it, so nothing looks stale.
	sources, err := other.Sources(f.profile.ID)
	f.ok(t, err)
	if len(sources) != 1 {
		t.Fatalf("sources = %+v", sources)
	}
	if sources[0].Channels != 3 || sources[0].PlaylistAt == 0 || sources[0].Refreshing {
		t.Fatalf("source = %+v", sources[0])
	}
}

func TestErrorsNameNoURL(t *testing.T) {
	f := newServiceFixture(t)
	src := f.add(t)
	channels, err := f.s.Channels(f.profile.ID, src.ID)
	f.ok(t, err)

	// A source that can't be reached reports a code, not the URL it tried.
	broken, err := f.s.AddSource(SourceInput{
		ProfileID:   f.profile.ID,
		PlaylistURL: f.srv.URL + "/missing.m3u",
		GuideURL:    f.srv.URL + "/gone.xml.gz",
	})
	f.ok(t, err)
	done := f.waitIdle(t, broken.ID)
	if done.PlaylistError != CodeUnreachable {
		t.Fatalf("playlistError = %q", done.PlaylistError)
	}
	for _, code := range []string{done.PlaylistError, done.GuideError} {
		if strings.ContainsAny(code, "/:?=") {
			t.Fatalf("%q is not a code", code)
		}
	}

	// What a bound method returns is a code as well.
	checked := []error{
		func() error {
			_, err := f.s.AddSource(SourceInput{ProfileID: f.profile.ID, PlaylistURL: "ftp://" + f.srv.URL})
			return err
		}(),
		func() error { _, err := f.s.Channels(f.profile.ID, "nope"); return err }(),
		func() error { _, err := f.s.Stream(f.profile.ID, channels[0].ID+"extra"); return err }(),
		func() error { _, err := f.s.Guide(f.profile.ID, nil, 2, 1); return err }(),
		f.s.RenameSource(f.profile.ID, src.ID, "  "),
	}
	for i, err := range checked {
		if err == nil {
			t.Fatalf("check %d returned no error", i)
		}
		if strings.Contains(err.Error(), f.srv.URL) || strings.Contains(err.Error(), "127.0.0.1") {
			t.Fatalf("error names a URL: %v", err)
		}
	}
}
