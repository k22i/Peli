package anilistaddon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// metaAnswer is Stremio's meta response.
type metaAnswer struct {
	Meta metaItem `json:"meta"`
}

type metaItem struct {
	preview
	Runtime        string         `json:"runtime,omitempty"`
	Country        string         `json:"country,omitempty"`
	Links          []link         `json:"links,omitempty"`
	TrailerStreams []trailer      `json:"trailerStreams,omitempty"`
	Videos         []video        `json:"videos,omitempty"`
	BehaviorHints  map[string]any `json:"behaviorHints,omitempty"`
}

type link struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	URL      string `json:"url"`
}

type trailer struct {
	Title string `json:"title"`
	YtID  string `json:"ytId"`
}

type video struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Released  string `json:"released,omitempty"`
	Thumbnail string `json:"thumbnail,omitempty"`
	Overview  string `json:"overview,omitempty"`
	Season    int    `json:"season"`
	Episode   int    `json:"episode"`
}

type airing struct {
	Episode  int   `json:"episode"`
	AiringAt int64 `json:"airingAt"`
}

const metaQuery = `query ($id: Int) {
	Media(id: $id, type: ANIME) {
		` + mediaFields + `
		episodes duration countryOfOrigin siteUrl
		studios(isMain: true) { nodes { name siteUrl } }
		trailer { id site }
		nextAiringEpisode { episode airingAt }
		upcoming: airingSchedule(notYetAired: true, perPage: 50) { nodes { episode airingAt } }
		aired: airingSchedule(perPage: 50) { nodes { episode airingAt } }
	}
}`

// meta answers a title's details: AniList's, with episodes from Kitsu. A
// title AniList doesn't have, or an id the anime list can't map, is not
// found, so the next addon with details answers.
func (a *Addon) meta(ctx context.Context, typ, id string) (metaAnswer, error) {
	if typ != "series" && typ != "movie" {
		return metaAnswer{}, errNotFound
	}
	anilistID := a.anilistOf(ctx, id)
	if anilistID == 0 {
		return metaAnswer{}, errNotFound
	}
	var out struct {
		Media *struct {
			media
			Episodes int    `json:"episodes"`
			Duration int    `json:"duration"`
			Country  string `json:"countryOfOrigin"`
			SiteURL  string `json:"siteUrl"`
			Studios  struct {
				Nodes []struct {
					Name    string `json:"name"`
					SiteURL string `json:"siteUrl"`
				} `json:"nodes"`
			} `json:"studios"`
			Trailer *struct {
				ID   string `json:"id"`
				Site string `json:"site"`
			} `json:"trailer"`
			Next     *airing `json:"nextAiringEpisode"`
			Upcoming struct {
				Nodes []airing `json:"nodes"`
			} `json:"upcoming"`
			Aired struct {
				Nodes []airing `json:"nodes"`
			} `json:"aired"`
		} `json:"Media"`
	}
	if err := a.query(ctx, metaQuery, map[string]any{"id": anilistID}, &out); err != nil {
		return metaAnswer{}, err
	}
	m := out.Media
	if m == nil || m.IsAdult {
		return metaAnswer{}, errNotFound
	}
	item := metaItem{preview: a.previewOf(ctx, m.media), Country: m.Country}
	// The id asked for, so the title keeps the id it was opened with.
	item.ID = id
	item.Type = typ
	if m.Duration > 0 {
		item.Runtime = fmt.Sprintf("%d min", m.Duration)
	}
	for _, s := range m.Studios.Nodes {
		item.Links = append(item.Links, link{Name: s.Name, Category: "Studios", URL: s.SiteURL})
	}
	if m.SiteURL != "" {
		item.Links = append(item.Links, link{Name: "AniList", Category: "AniList", URL: m.SiteURL})
	}
	if m.Trailer != nil && m.Trailer.Site == "youtube" && m.Trailer.ID != "" {
		item.TrailerStreams = []trailer{{Title: "Trailer", YtID: m.Trailer.ID}}
	}
	if typ == "movie" {
		item.BehaviorHints = map[string]any{"defaultVideoId": id}
		return metaAnswer{Meta: item}, nil
	}

	schedule := map[int]int64{}
	for _, n := range append(m.Aired.Nodes, m.Upcoming.Nodes...) {
		schedule[n.Episode] = n.AiringAt
	}
	if m.Next != nil {
		schedule[m.Next.Episode] = m.Next.AiringAt
	}
	var kitsu map[int]kitsuEpisode
	if prefix, rest, _ := strings.Cut(id, ":"); prefix == "kitsu" {
		kitsu = a.kitsuEpisodes(ctx, rest)
	} else if a.list == nil {
	} else if e, ok := a.list.ByAniList(ctx, anilistID); ok && e.Kitsu != 0 {
		kitsu = a.kitsuEpisodes(ctx, strconv.Itoa(e.Kitsu))
	}

	count := m.Episodes
	if count == 0 {
		for n := range schedule {
			count = max(count, n)
		}
		for n := range kitsu {
			count = max(count, n)
		}
	}
	for n := 1; n <= count; n++ {
		v := video{ID: fmt.Sprintf("%s:%d", id, n), Title: fmt.Sprintf("Episode %d", n), Season: 1, Episode: n}
		if k, ok := kitsu[n]; ok {
			v.Title = cmpOr(k.title, v.Title)
			v.Thumbnail, v.Overview, v.Released = k.thumbnail, k.overview, k.airdate
		}
		if at, ok := schedule[n]; ok {
			v.Released = time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		}
		item.Videos = append(item.Videos, v)
	}
	if m.Status == "RELEASING" || m.Status == "NOT_YET_RELEASED" {
		item.BehaviorHints = map[string]any{"hasScheduledVideos": true}
	}
	return metaAnswer{Meta: item}, nil
}

type kitsuEpisode struct {
	title, thumbnail, overview, airdate string
}

// kitsuPage is Kitsu's largest page of episodes.
const kitsuPage = 20

// kitsuMaxPages caps a long show's episode list (1,500 episodes).
const kitsuMaxPages = 75

// kitsuEpisodes reads a show's episodes from Kitsu's public API, by number.
// It gives up quietly: titles then read "Episode N".
func (a *Addon) kitsuEpisodes(ctx context.Context, kitsuID string) map[int]kitsuEpisode {
	if a.kitsu == "" {
		return nil
	}
	page := func(offset int) (eps []kitsuEpisode, numbers []int, total int, err error) {
		u := fmt.Sprintf("%s/anime/%s/episodes?page%%5Blimit%%5D=%d&page%%5Boffset%%5D=%d&sort=number", a.kitsu, kitsuID, kitsuPage, offset)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, nil, 0, err
		}
		req.Header.Set("Accept", "application/vnd.api+json")
		req.Header.Set("User-Agent", "Sinag/"+a.version+" (+https://github.com/k22i/Sinag)")
		res, err := a.http.Do(req)
		if err != nil {
			return nil, nil, 0, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, nil, 0, fmt.Errorf("kitsu: HTTP %d", res.StatusCode)
		}
		var body struct {
			Data []struct {
				Attributes struct {
					Number         int    `json:"number"`
					CanonicalTitle string `json:"canonicalTitle"`
					Titles         struct {
						EnUS string `json:"en_us"`
						En   string `json:"en"`
						EnJP string `json:"en_jp"`
					} `json:"titles"`
					Airdate   string `json:"airdate"`
					Synopsis  string `json:"synopsis"`
					Thumbnail *struct {
						Original string `json:"original"`
					} `json:"thumbnail"`
				} `json:"attributes"`
			} `json:"data"`
			Meta struct {
				Count int `json:"count"`
			} `json:"meta"`
		}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			return nil, nil, 0, err
		}
		for _, d := range body.Data {
			at := d.Attributes
			e := kitsuEpisode{
				title:    cmpOr(at.Titles.EnUS, at.Titles.En, at.CanonicalTitle, at.Titles.EnJP),
				overview: plain(at.Synopsis),
			}
			if at.Thumbnail != nil {
				e.thumbnail = at.Thumbnail.Original
			}
			if t, err := time.Parse(time.DateOnly, at.Airdate); err == nil {
				e.airdate = t.Format("2006-01-02T15:04:05.000Z")
			}
			eps, numbers = append(eps, e), append(numbers, at.Number)
		}
		return eps, numbers, body.Meta.Count, nil
	}

	eps, numbers, total, err := page(0)
	if err != nil {
		return nil
	}
	byNumber := map[int]kitsuEpisode{}
	var mu sync.Mutex
	keep := func(eps []kitsuEpisode, numbers []int) {
		mu.Lock()
		defer mu.Unlock()
		for i, e := range eps {
			if numbers[i] > 0 {
				byNumber[numbers[i]] = e
			}
		}
	}
	keep(eps, numbers)
	pages := min((total+kitsuPage-1)/kitsuPage, kitsuMaxPages)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for p := 1; p < pages; p++ {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			if eps, numbers, _, err := page(p * kitsuPage); err == nil {
				keep(eps, numbers)
			}
		})
	}
	wg.Wait()
	return byNumber
}
