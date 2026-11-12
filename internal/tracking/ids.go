package tracking

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/k22i/Peli/internal/animelist"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/simkl"
)

// ID mapping (#73, #105). What plays is named by its addon's content id
// ("tt0903747", "kitsu:46474", "tmdb:1396"), and the frontend adds the ids
// the addon's meta gave (Watching.IDs). Anime addons' ids name one entry per
// season or cour, numbered from 1, as SIMKL's and AniList's anime catalogs
// do; Cinemeta's name a whole series by TVDB's seasons.

// animeKeys are the anime-native catalogs, in the order they're trusted.
var animeKeys = []string{"anilist", "mal", "kitsu", "anidb"}

// westernKeys are the catalogs that number a series by seasons.
var westernKeys = []string{"imdb", "tmdb", "tvdb"}

var (
	imdbID  = regexp.MustCompile(`^tt\d{1,10}$`)
	numeric = regexp.MustCompile(`^\d{1,10}$`)
)

// ids returns w's ids by catalog: the content id's own, then the meta's.
func ids(w playback.Watching) map[string]string {
	out := map[string]string{}
	for key, value := range w.IDs {
		key = strings.ToLower(key)
		value = strings.TrimSpace(value)
		if key == "imdb" && imdbID.MatchString(value) || key != "imdb" && numeric.MatchString(value) {
			out[key] = value
		}
	}
	id := w.ContentID
	switch {
	case imdbID.MatchString(id):
		out["imdb"] = id
	default:
		prefix, rest, ok := strings.Cut(id, ":")
		if !ok {
			// "mal_123", as some anime addons write it.
			prefix, rest, ok = strings.Cut(id, "_")
		}
		if ok && numeric.MatchString(rest) {
			switch prefix = strings.ToLower(prefix); prefix {
			case "kitsu", "mal", "anilist", "anidb", "tmdb", "tvdb":
				out[prefix] = rest
			}
		}
	}
	return out
}

// animeNative reports whether w's content id is an anime catalog's, so its
// episodes are numbered within the one cour.
func animeNative(w playback.Watching) bool {
	prefix, _, ok := strings.Cut(w.ContentID, ":")
	if !ok {
		prefix, _, ok = strings.Cut(w.ContentID, "_")
	}
	if !ok {
		return false
	}
	switch strings.ToLower(prefix) {
	case "kitsu", "mal", "anilist", "anidb":
		return true
	}
	return false
}

// isAnime reports whether w is anime: an anime catalog's id, or an IMDb id
// the anime list knows.
func (s *Service) isAnime(ctx context.Context, w playback.Watching) bool {
	if animeNative(w) {
		return true
	}
	all := ids(w)
	for _, key := range animeKeys {
		if all[key] != "" {
			return true
		}
	}
	return s.anime != nil && s.anime.IsAnime(ctx, all["imdb"])
}

func isMovie(w playback.Watching) bool { return w.ContentType == "movie" }

// simklItem is what SIMKL scrobbles w as, or false when there aren't the
// ids or numbers for it. An anime catalog's title goes as anime with its
// own ids only: SIMKL tries ids in a fixed order, and an IMDb id would
// name the whole series while the episode's number counts within the cour.
func simklItem(w playback.Watching) (simkl.Item, bool) {
	all := ids(w)
	media := &simkl.Media{Title: w.Name, Year: w.Year, IDs: simkl.IDs{}}
	if media.Title == "" {
		media.Title = w.Title
	}
	native := animeNative(w)
	keys := westernKeys
	if native {
		keys = animeKeys
	}
	for _, key := range keys {
		if all[key] != "" {
			media.IDs[key] = all[key]
		}
	}
	if len(media.IDs) == 0 {
		return simkl.Item{}, false
	}
	if isMovie(w) {
		if native {
			return simkl.Item{Anime: media}, true
		}
		return simkl.Item{Movie: media}, true
	}
	if w.Episode == nil {
		return simkl.Item{}, false
	}
	if native {
		return simkl.Item{Anime: media, Episode: &simkl.Episode{Number: *w.Episode}}, true
	}
	if w.Season == nil {
		return simkl.Item{}, false
	}
	season := *w.Season
	return simkl.Item{Show: media, Episode: &simkl.Episode{Season: &season, Number: *w.Episode}}, true
}

// aniListRef is how the anime list looks w up.
func aniListRef(w playback.Watching) animelist.Ref {
	all := ids(w)
	num := func(key string) int { n, _ := strconv.Atoi(all[key]); return n }
	ref := animelist.Ref{AniList: num("anilist"), MAL: num("mal"), Kitsu: num("kitsu")}
	if w.Episode != nil {
		ref.Episode = *w.Episode
	}
	if animeNative(w) {
		// The episode counts within the cour the id names; an IMDb id
		// from the meta names the series, so it isn't used.
		return ref
	}
	ref.IMDb = all["imdb"]
	if w.Season != nil {
		ref.Season = *w.Season
	}
	if isMovie(w) {
		ref.Season, ref.Episode = 0, 0
	}
	return ref
}
