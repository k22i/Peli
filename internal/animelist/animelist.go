// Package animelist maps anime between catalogs (#105): Kitsu, MyAnimeList
// and IMDb ids (with TVDB's season numbering, as Cinemeta has it) to
// AniList's entries, one per season or cour, and back. The mapping is
// Fribb/anime-lists' anime-list-mini.json, downloaded once and kept on this
// device, then refreshed weekly; with no copy and no connection, nothing
// maps. See ADR-0042.
package animelist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultURL is the list's raw file on GitHub.
const DefaultURL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json"

// RefreshEvery is how old the kept copy gets before it's downloaded again.
const RefreshEvery = 7 * 24 * time.Hour

// ErrUnavailable means there's no copy of the list and it can't be
// downloaded now.
var ErrUnavailable = errors.New("animelist: mapping list unavailable")

// Entry is one AniList entry (a season, a cour, a film or a special) and the
// other catalogs' ids for it.
type Entry struct {
	AniList int
	Kitsu   int
	MAL     int
	IMDb    []string
	// TVDB's season the entry is in (0 for specials), and how many of that
	// season's episodes come before its first, for a season split into
	// cours. Season is nil when the list doesn't say.
	Season *int
	Offset int
	// "TV", "MOVIE", "OVA", "ONA", "SPECIAL"…
	Type string
	// What the list's TMDB id names: "movie", "tv", or "" when it has none.
	// It says whether the IMDb id is a film's or a show's, which Type
	// doesn't: films filed as a show's specials carry the show's IMDb id.
	TMDB string
}

// wire is a row of the file. imdb_id is a list; the offsets and seasons
// are per catalog.
type wire struct {
	Type    string   `json:"type"`
	AniList int      `json:"anilist_id"`
	Kitsu   int      `json:"kitsu_id"`
	MAL     int      `json:"mal_id"`
	IMDb    []string `json:"imdb_id"`
	Season  *struct {
		TVDB *int `json:"tvdb"`
	} `json:"season"`
	Offset *struct {
		TVDB *int `json:"tvdb"`
	} `json:"episode_offset"`
	// {"movie": [ids]} or {"tv": id}; read leniently, so a row in another
	// shape doesn't lose the whole list.
	TMDB json.RawMessage `json:"themoviedb_id"`
}

// List is the mapping, loaded on first use.
//
// Lookups never wait on a download while another holds the maps (#128):
// load serialises reading and downloading the list, and mu only guards the
// maps, so a lookup that can do without the list (Peek: the Anime tab, the
// leave-out filter, poster titles) answers at once.
type List struct {
	url  string
	path string
	http *http.Client
	now  func() time.Time
	// allowDownload says whether a download that can wait (Warm, Peek) may
	// run now; nil is always. On iOS it is false on mobile data.
	allowDownload func() bool

	load    sync.Mutex
	warming atomic.Bool

	mu      sync.Mutex
	loaded  time.Time
	tried   time.Time
	anilist map[int]*Entry
	kitsu   map[int]*Entry
	mal     map[int]*Entry
	imdb    map[string][]*Entry
}

// New returns a list kept at dir/anime-list.json, downloaded from url.
func New(url, dir string) *List {
	return &List{
		url: url, path: filepath.Join(dir, "anime-list.json"),
		http: &http.Client{Timeout: 2 * time.Minute}, now: time.Now,
	}
}

// OnlyWhen makes the downloads that can wait (Warm, Peek) run only while
// allow says so: on iOS, off mobile data. A lookup that needs the list now
// (Find, IsAnime, ByAniList) still downloads it. Call before the list is
// shared.
func (l *List) OnlyWhen(allow func() bool) { l.allowDownload = allow }

// FromEntries returns a list of entries, never downloaded: for tests.
func FromEntries(entries []Entry) *List {
	l := &List{now: time.Now}
	l.index(entries)
	l.loaded = time.Now().Add(1000 * time.Hour)
	return l
}

// ensure loads the kept copy, and downloads a new one if it's missing. A
// copy a week old is still used while a new one downloads behind it. A
// failed download keeps the old copy and isn't tried again for an hour.
func (l *List) ensure(ctx context.Context) error { return l.fill(ctx, true) }

// fill is ensure; download false only reads the kept copy, unless the list
// may download now (allowDownload).
func (l *List) fill(ctx context.Context, download bool) error {
	if has, stale := l.state(); has {
		if stale {
			l.refreshBehind()
		}
		return nil
	}
	l.load.Lock()
	defer l.load.Unlock()
	if has, _ := l.state(); has {
		return nil
	}
	if l.path != "" {
		if info, err := os.Stat(l.path); err == nil {
			if entries, err := readFile(l.path); err == nil {
				l.swap(entries, info.ModTime())
			} else {
				slog.Warn("animelist: kept copy unreadable", "error", err)
			}
		}
	}
	has, stale := l.state()
	if has && !stale {
		return nil
	}
	if download || l.allowDownload == nil || l.allowDownload() {
		l.downloadNow(ctx)
	}
	if has, _ := l.state(); !has {
		return ErrUnavailable
	}
	return nil
}

// state is whether the maps are there, and whether they're a week old.
func (l *List) state() (has, stale bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.anilist != nil, l.now().Sub(l.loaded) >= RefreshEvery
}

// downloadNow downloads the list unless it was tried within the hour. Call
// with l.load held.
func (l *List) downloadNow(ctx context.Context) {
	now := l.now()
	l.mu.Lock()
	recent := now.Sub(l.tried) < time.Hour
	if !recent {
		l.tried = now
	}
	l.mu.Unlock()
	if recent || l.url == "" {
		return
	}
	entries, err := l.download(ctx)
	if err != nil {
		slog.Warn("animelist: download failed", "error", err)
		return
	}
	l.swap(entries, now)
}

// refreshBehind downloads a new copy of a week-old list in the background,
// when the list may download now.
func (l *List) refreshBehind() {
	if l.url == "" || (l.allowDownload != nil && !l.allowDownload()) || !l.warming.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer l.warming.Store(false)
		l.load.Lock()
		defer l.load.Unlock()
		if _, stale := l.state(); stale {
			l.downloadNow(context.Background())
		}
	}()
}

// Peek reports whether the list is loaded, without waiting: when it isn't,
// it starts loading it in the background (the kept copy, or a download when
// the list may download now), so a later look finds it.
func (l *List) Peek() bool {
	has, stale := l.state()
	if has {
		if stale {
			l.refreshBehind()
		}
		return true
	}
	if l.warming.CompareAndSwap(false, true) {
		go func() {
			defer l.warming.Store(false)
			_ = l.fill(context.Background(), false)
		}()
	}
	return false
}

func (l *List) download(ctx context.Context) ([]Entry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.url, nil)
	if err != nil {
		return nil, err
	}
	res, err := l.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	entries, err := parse(data)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err == nil {
		tmp := l.path + ".tmp"
		if err := os.WriteFile(tmp, data, 0o600); err == nil {
			_ = os.Rename(tmp, l.path)
		}
	}
	return entries, nil
}

func readFile(path string) ([]Entry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parse(data)
}

func parse(data []byte) ([]Entry, error) {
	var rows []wire
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(rows))
	for _, row := range rows {
		if row.AniList == 0 {
			continue
		}
		e := Entry{AniList: row.AniList, Kitsu: row.Kitsu, MAL: row.MAL, IMDb: row.IMDb, Type: row.Type}
		if row.Season != nil && row.Season.TVDB != nil {
			season := *row.Season.TVDB
			e.Season = &season
		}
		if row.Offset != nil && row.Offset.TVDB != nil {
			e.Offset = *row.Offset.TVDB
		}
		var tmdb map[string]json.RawMessage
		if json.Unmarshal(row.TMDB, &tmdb) == nil {
			if _, ok := tmdb["movie"]; ok {
				e.TMDB = "movie"
			} else if _, ok := tmdb["tv"]; ok {
				e.TMDB = "tv"
			}
		}
		entries = append(entries, e)
	}
	if len(entries) == 0 {
		return nil, errors.New("animelist: empty list")
	}
	return entries, nil
}

// swap indexes entries outside the lock and puts the maps in place.
func (l *List) swap(entries []Entry, loaded time.Time) {
	fresh := &List{}
	fresh.index(entries)
	l.mu.Lock()
	l.anilist, l.kitsu, l.mal, l.imdb = fresh.anilist, fresh.kitsu, fresh.mal, fresh.imdb
	l.loaded = loaded
	l.mu.Unlock()
}

// index replaces the maps. Call with l.mu held, or before l is shared.
func (l *List) index(entries []Entry) {
	l.anilist = make(map[int]*Entry, len(entries))
	l.kitsu, l.mal, l.imdb = map[int]*Entry{}, map[int]*Entry{}, map[string][]*Entry{}
	for i := range entries {
		e := &entries[i]
		l.anilist[e.AniList] = e
		if e.Kitsu != 0 {
			l.kitsu[e.Kitsu] = e
		}
		if e.MAL != 0 {
			l.mal[e.MAL] = e
		}
		for _, id := range e.IMDb {
			l.imdb[id] = append(l.imdb[id], e)
		}
	}
}

// Warm loads the list at launch, so the first lookup doesn't wait for it:
// the kept copy, or a download when the list may download now (on iOS, not
// on mobile data; a later Peek or lookup tries again).
func (l *List) Warm(ctx context.Context) { _ = l.fill(ctx, false) }

// Ref names a title the way Peli's addons do, for Find.
type Ref struct {
	Kitsu   int
	MAL     int
	AniList int
	IMDb    string
	// TVDB-style season and episode (Cinemeta's); 0 season for a film.
	Season, Episode int
}

// Find returns the AniList entry ref plays and the episode within it: an
// AniList id as it is, then Kitsu and MyAnimeList ids, then the IMDb id's
// entry for that season, the cour the episode falls in. ok is false when the
// title isn't anime the list knows.
func (l *List) Find(ctx context.Context, ref Ref) (entry Entry, episode int, ok bool) {
	if err := l.ensure(ctx); err != nil {
		if ref.AniList != 0 {
			return Entry{AniList: ref.AniList}, max(ref.Episode, 1), true
		}
		return Entry{}, 0, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	episode = max(ref.Episode, 1)
	switch {
	case ref.AniList != 0:
		if e := l.anilist[ref.AniList]; e != nil {
			return *e, episode, true
		}
		return Entry{AniList: ref.AniList}, episode, true
	case ref.Kitsu != 0 && l.kitsu[ref.Kitsu] != nil:
		return *l.kitsu[ref.Kitsu], episode, true
	case ref.MAL != 0 && l.mal[ref.MAL] != nil:
		return *l.mal[ref.MAL], episode, true
	case ref.IMDb != "":
		return pickCour(l.imdb[ref.IMDb], ref.Season, ref.Episode)
	}
	return Entry{}, 0, false
}

// pickCour picks the entry of season whose offset is the largest still
// before episode. A film (season 0, episode 0) takes the only entry there
// is, or the one typed MOVIE.
func pickCour(entries []*Entry, season, episode int) (Entry, int, bool) {
	if season == 0 && episode == 0 {
		var films []*Entry
		for _, e := range entries {
			if e.Type == "MOVIE" {
				films = append(films, e)
			}
		}
		if len(films) == 0 && len(entries) == 1 {
			films = entries
		}
		if len(films) != 1 {
			return Entry{}, 0, false
		}
		return *films[0], 1, true
	}
	var best *Entry
	for _, e := range entries {
		if e.Season == nil || *e.Season != season || e.Offset >= episode {
			continue
		}
		if best == nil || e.Offset > best.Offset {
			best = e
		}
	}
	if best == nil {
		return Entry{}, 0, false
	}
	return *best, episode - best.Offset, true
}

// IsAnime reports whether the list knows imdb as an anime.
func (l *List) IsAnime(ctx context.Context, imdb string) bool {
	if imdb == "" || l.ensure(ctx) != nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.imdb[imdb]) > 0
}

// ByAniList returns AniList entry id's other ids.
func (l *List) ByAniList(ctx context.Context, id int) (Entry, bool) {
	if l.ensure(ctx) != nil {
		return Entry{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.anilist[id]
	if e == nil {
		return Entry{}, false
	}
	return *e, true
}
