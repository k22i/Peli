package anilistaddon

import (
	"context"
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/k22i/Peli/internal/animelist"
)

// Genres are AniList's, without Hentai: adult titles are never listed.
var Genres = []string{
	"Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha",
	"Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
}

// perPage is AniList's largest page.
const perPage = 50

// A list the addon offers, in the order they show.
type list struct {
	id, name string
	sort     string
	// season is "this" or "next"; empty for all seasons.
	season string
}

var lists = []list{
	{"trending", "Trending", "TRENDING_DESC", ""},
	{"season", "This season", "POPULARITY_DESC", "this"},
	{"next-season", "Next season", "POPULARITY_DESC", "next"},
	{"popular", "Popular", "POPULARITY_DESC", ""},
	{"top", "Top rated", "SCORE_DESC", ""},
}

type manifest struct {
	ID            string         `json:"id"`
	Version       string         `json:"version"`
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	Logo          string         `json:"logo"`
	Types         []string       `json:"types"`
	IDPrefixes    []string       `json:"idPrefixes"`
	Resources     []any          `json:"resources"`
	Catalogs      []catalogEntry `json:"catalogs"`
	BehaviorHints map[string]any `json:"behaviorHints"`
}

type catalogEntry struct {
	Type  string  `json:"type"`
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Extra []extra `json:"extra"`
}

type extra struct {
	Name       string   `json:"name"`
	IsRequired bool     `json:"isRequired,omitempty"`
	Options    []string `json:"options,omitempty"`
}

var idPrefixes = []string{"kitsu:", "anilist:"}

func (a *Addon) manifest() manifest {
	m := manifest{
		// The id from when the app was Sinag, kept: Home layouts and folders
		// (synced to Nuvio) name catalogs by addon id.
		ID: "sinag.anilist", Version: a.version, Name: "AniList",
		Description: "AniList’s lists and details for anime. Built into Peli.",
		Logo:        "https://anilist.co/img/icons/android-chrome-512x512.png",
		Types:       []string{"anime", "series", "movie"},
		IDPrefixes:  idPrefixes,
		Resources: []any{
			"catalog",
			map[string]any{"name": "meta", "types": []string{"series", "movie"}, "idPrefixes": idPrefixes},
		},
		BehaviorHints: map[string]any{},
	}
	for _, l := range lists {
		m.Catalogs = append(m.Catalogs, catalogEntry{
			Type: "anime", ID: l.id, Name: l.name,
			Extra: []extra{{Name: "genre", Options: Genres}, {Name: "skip"}},
		})
	}
	m.Catalogs = append(m.Catalogs, catalogEntry{
		Type: "anime", ID: "search", Name: "Search",
		Extra: []extra{{Name: "search", IsRequired: true}, {Name: "skip"}},
	})
	return m
}

// preview is a catalog item, as Stremio's MetaPreview.
type preview struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Name        string   `json:"name"`
	Poster      string   `json:"poster,omitempty"`
	PosterShape string   `json:"posterShape,omitempty"`
	Background  string   `json:"background,omitempty"`
	Description string   `json:"description,omitempty"`
	ReleaseInfo string   `json:"releaseInfo,omitempty"`
	Released    string   `json:"released,omitempty"`
	IMDbRating  string   `json:"imdbRating,omitempty"`
	Genres      []string `json:"genres,omitempty"`
}

type catalogAnswer struct {
	Metas   []preview `json:"metas"`
	HasMore bool      `json:"hasMore"`
}

// media is the part of AniList's Media both lists and details ask for.
type media struct {
	ID     int    `json:"id"`
	Format string `json:"format"`
	Status string `json:"status"`
	Title  struct {
		Romaji  string `json:"romaji"`
		English string `json:"english"`
	} `json:"title"`
	Description string `json:"description"`
	StartDate   date   `json:"startDate"`
	EndDate     date   `json:"endDate"`
	Genres      []string
	Score       int `json:"averageScore"`
	Cover       struct {
		ExtraLarge string `json:"extraLarge"`
		Large      string `json:"large"`
	} `json:"coverImage"`
	Banner  string `json:"bannerImage"`
	IsAdult bool   `json:"isAdult"`
}

type date struct {
	Year  int `json:"year"`
	Month int `json:"month"`
	Day   int `json:"day"`
}

const mediaFields = `id format status isAdult title { romaji english } description(asHtml: false)
	startDate { year month day } endDate { year month day } genres averageScore
	coverImage { extraLarge large } bannerImage`

const catalogQuery = `query ($page: Int, $perPage: Int, $sort: [MediaSort], $season: MediaSeason, $seasonYear: Int, $genre: String, $search: String) {
	Page(page: $page, perPage: $perPage) {
		pageInfo { hasNextPage }
		media(type: ANIME, isAdult: false, format_not_in: [MUSIC], sort: $sort, season: $season, seasonYear: $seasonYear, genre: $genre, search: $search) {
			` + mediaFields + `
		}
	}
}`

// catalog answers one page of list id, from extra's genre, search and skip.
func (a *Addon) catalog(ctx context.Context, typ, id string, extra map[string][]string) (catalogAnswer, error) {
	if typ != "anime" {
		return catalogAnswer{}, errNotFound
	}
	skip, _ := strconv.Atoi(first(extra["skip"]))
	skip = max(skip, 0)
	vars := map[string]any{"page": skip/perPage + 1, "perPage": perPage}
	if genre := first(extra["genre"]); genre != "" {
		vars["genre"] = genre
	}
	if id == "search" {
		q := strings.TrimSpace(first(extra["search"]))
		if q == "" {
			return catalogAnswer{}, errNotFound
		}
		vars["search"], vars["sort"] = q, []string{"SEARCH_MATCH"}
	} else {
		var l *list
		for i := range lists {
			if lists[i].id == id {
				l = &lists[i]
			}
		}
		if l == nil {
			return catalogAnswer{}, errNotFound
		}
		vars["sort"] = []string{l.sort, "ID"}
		if l.season != "" {
			season, year := seasonOf(a.now(), l.season == "next")
			vars["season"], vars["seasonYear"] = season, year
		}
	}
	var out struct {
		Page struct {
			PageInfo struct {
				HasNextPage bool `json:"hasNextPage"`
			} `json:"pageInfo"`
			Media []media `json:"media"`
		} `json:"Page"`
	}
	if err := a.query(ctx, catalogQuery, vars, &out); err != nil {
		return catalogAnswer{}, err
	}
	answer := catalogAnswer{Metas: []preview{}, HasMore: out.Page.PageInfo.HasNextPage}
	items := out.Page.Media
	if offset := skip % perPage; offset > 0 {
		items = items[min(offset, len(items)):]
	}
	for _, m := range items {
		if m.IsAdult {
			continue
		}
		answer.Metas = append(answer.Metas, a.previewOf(ctx, m))
	}
	return answer, nil
}

// seasonOf is AniList's season (WINTER is January to March) that now is in,
// or the one after it.
func seasonOf(now time.Time, next bool) (string, int) {
	seasons := []string{"WINTER", "SPRING", "SUMMER", "FALL"}
	i, year := (int(now.Month())-1)/3, now.Year()
	if next {
		i++
		if i == 4 {
			i, year = 0, year+1
		}
	}
	return seasons[i], year
}

// idOf is the id a title goes by: its Kitsu id, which stream addons take,
// or its AniList id when the anime list has none.
func (a *Addon) idOf(ctx context.Context, anilistID int) string {
	if a.list != nil {
		if e, ok := a.list.ByAniList(ctx, anilistID); ok && e.Kitsu != 0 {
			return fmt.Sprintf("kitsu:%d", e.Kitsu)
		}
	}
	return fmt.Sprintf("anilist:%d", anilistID)
}

// anilistOf is the AniList id behind one of the addon's ids, or 0.
func (a *Addon) anilistOf(ctx context.Context, id string) int {
	prefix, rest, ok := strings.Cut(id, ":")
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n <= 0 {
		return 0
	}
	switch prefix {
	case "anilist":
		return n
	case "kitsu":
		if a.list == nil {
			return 0
		}
		if e, _, ok := a.list.Find(ctx, animelist.Ref{Kitsu: n}); ok {
			return e.AniList
		}
	}
	return 0
}

func (a *Addon) previewOf(ctx context.Context, m media) preview {
	p := preview{
		ID: a.idOf(ctx, m.ID), Type: typeOf(m.Format), Name: titleOf(m),
		Poster: cmpOr(m.Cover.ExtraLarge, m.Cover.Large), PosterShape: "poster",
		Background: m.Banner, Description: plain(m.Description),
		ReleaseInfo: releaseInfo(m), Released: m.StartDate.iso(), Genres: m.Genres,
	}
	if m.Score > 0 {
		p.IMDbRating = fmt.Sprintf("%.1f", float64(m.Score)/10)
	}
	return p
}

// typeOf is the Stremio type of an AniList format: films are movies, and
// everything else (TV, ONA, OVA, specials) a series, as Kitsu's addon has it.
func typeOf(format string) string {
	if format == "MOVIE" {
		return "movie"
	}
	return "series"
}

func titleOf(m media) string { return cmpOr(m.Title.English, m.Title.Romaji) }

func releaseInfo(m media) string {
	if m.StartDate.Year == 0 {
		return ""
	}
	start := strconv.Itoa(m.StartDate.Year)
	switch {
	case m.Format == "MOVIE":
		return start
	case m.Status == "RELEASING":
		return start + "–"
	case m.EndDate.Year != 0 && m.EndDate.Year != m.StartDate.Year:
		return fmt.Sprintf("%s–%d", start, m.EndDate.Year)
	}
	return start
}

// iso is the date as an ISO time at midnight UTC, or "" if it has no day.
func (d date) iso() string {
	if d.Year == 0 || d.Month == 0 || d.Day == 0 {
		return ""
	}
	return time.Date(d.Year, time.Month(d.Month), d.Day, 0, 0, 0, 0, time.UTC).Format("2006-01-02T15:04:05.000Z")
}

var (
	tags   = regexp.MustCompile(`<[^>]*>`)
	breaks = regexp.MustCompile(`(?i)<br\s*/?>`)
	blank  = regexp.MustCompile(`\n{3,}`)
)

// plain turns AniList's description, which keeps some HTML, into text.
func plain(s string) string {
	s = breaks.ReplaceAllString(s, "\n")
	s = html.UnescapeString(tags.ReplaceAllString(s, ""))
	return strings.TrimSpace(blank.ReplaceAllString(strings.ReplaceAll(s, "\r", ""), "\n\n"))
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func cmpOr(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
