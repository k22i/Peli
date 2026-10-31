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
}

// List is the mapping, loaded on first use.
type List struct {
	url  string
	path string
	http *http.Client
	now  func() time.Time

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

// FromEntries returns a list of entries, never downloaded: for tests.
func FromEntries(entries []Entry) *List {
	l := &List{now: time.Now}
	l.index(entries)
	l.loaded = time.Now().Add(1000 * time.Hour)
	return l
}

// ensure loads the kept copy, and downloads a new one if it's missing or a
// week old. A failed download keeps the old copy and isn't tried again for
// an hour.
func (l *List) ensure(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if l.anilist != nil && now.Sub(l.loaded) < RefreshEvery {
		return nil
	}
	if l.anilist == nil && l.path != "" {
		if info, err := os.Stat(l.path); err == nil {
			if err := l.readFile(); err == nil {
				l.loaded = info.ModTime()
			} else {
				slog.Warn("animelist: kept copy unreadable", "error", err)
			}
		}
	}
	if (l.anilist == nil || now.Sub(l.loaded) >= RefreshEvery) && now.Sub(l.tried) >= time.Hour && l.url != "" {
		l.tried = now
		if err := l.download(ctx); err != nil {
			slog.Warn("animelist: download failed", "error", err)
		} else {
			l.loaded = now
		}
	}
	if l.anilist == nil {
		return ErrUnavailable
	}
	return nil
}

func (l *List) download(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.url, nil)
	if err != nil {
		return err
	}
	res, err := l.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	entries, err := parse(data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err == nil {
		tmp := l.path + ".tmp"
		if err := os.WriteFile(tmp, data, 0o600); err == nil {
			_ = os.Rename(tmp, l.path)
		}
	}
	l.index(entries)
	return nil
}

func (l *List) readFile() error {
	data, err := os.ReadFile(l.path)
	if err != nil {
		return err
	}
	entries, err := parse(data)
	if err != nil {
		return err
	}
	l.index(entries)
	return nil
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
		entries = append(entries, e)
	}
	if len(entries) == 0 {
		return nil, errors.New("animelist: empty list")
	}
	return entries, nil
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

// Warm loads the list, downloading it if needed, so the first lookup
// doesn't wait for it.
func (l *List) Warm(ctx context.Context) { _ = l.ensure(ctx) }

// Ref names a title the way Sinag's addons do, for Find.
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
