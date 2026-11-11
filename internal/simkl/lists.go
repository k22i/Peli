package simkl

import (
	"context"
	"net/http"
	"net/url"
)

// Lists and ratings: which list a title is on, how the user rated it, and
// the plan-to-watch list. None of it records a watch.

// List names, as /sync/add-to-list takes them (the "to" field) and
// /sync/all-items filters by them.
const (
	ListPlanToWatch = "plantowatch"
	ListWatching    = "watching"
	ListCompleted   = "completed"
	ListHold        = "hold"
	ListDropped     = "dropped"
)

// ListItem moves a title to the list To.
type ListItem struct {
	Media
	To string `json:"to"`
}

// ListMove is a batch for /sync/add-to-list. Anime-native ids go under Anime,
// as in History.
type ListMove struct {
	Movies []ListItem `json:"movies,omitempty"`
	Shows  []ListItem `json:"shows,omitempty"`
	Anime  []ListItem `json:"anime,omitempty"`
}

// AddToList moves titles to lists without marking anything watched.
func (c *Client) AddToList(ctx context.Context, token string, move ListMove) error {
	return c.call(ctx, token, http.MethodPost, "/sync/add-to-list", nil, move, nil)
}

// RemoveFromList takes titles off every list. SIMKL has no call that only
// does that: /sync/history/remove is the documented way, and it clears the
// title's watched history with it.
func (c *Client) RemoveFromList(ctx context.Context, token string, titles History) error {
	return c.call(ctx, token, http.MethodPost, "/sync/history/remove", nil, titles, nil)
}

// RatedItem is a title and its rating, 1–10.
type RatedItem struct {
	Media
	Rating int `json:"rating,omitempty"`
}

// Ratings is a batch for /sync/ratings.
type Ratings struct {
	Movies []RatedItem `json:"movies,omitempty"`
	Shows  []RatedItem `json:"shows,omitempty"`
	Anime  []RatedItem `json:"anime,omitempty"`
}

// Rate sets ratings (1–10); an earlier rating is replaced.
func (c *Client) Rate(ctx context.Context, token string, ratings Ratings) error {
	return c.call(ctx, token, http.MethodPost, "/sync/ratings", nil, ratings, nil)
}

// Unrate clears the ratings of the titles given. They stay on their lists.
func (c *Client) Unrate(ctx context.Context, token string, ratings Ratings) error {
	return c.call(ctx, token, http.MethodPost, "/sync/ratings/remove", nil, ratings, nil)
}

// Items returns the user's titles of kind ("movies", "shows" or "anime") on
// list, or on every list when list is "". It leaves out episodes, so it stays
// small; each item carries the user's rating.
func (c *Client) Items(ctx context.Context, token, kind, list string) (Library, error) {
	path := "/sync/all-items/" + kind
	if list != "" {
		path += "/" + list
	}
	var out Library
	err := c.call(ctx, token, http.MethodGet, path, url.Values{"extended": {"full"}}, nil, &out)
	return out, err
}

// PosterURL is the picture for a poster id SIMKL gave, or "".
func PosterURL(poster string) string {
	if poster == "" {
		return ""
	}
	return "https://simkl.in/posters/" + poster + "_m.webp"
}
