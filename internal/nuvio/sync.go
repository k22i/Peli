package nuvio

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// The sync RPCs for library, watch progress, watched items and addons, as
// docs/spikes/nuvio-backend.md catalogues them. Profiles are addressed by
// index (1–6). Every push sends p_origin_client_id: PostgREST picks an
// overload by argument names, so a call without it can match the wrong
// function or none (PGRST202).
//
// What the server does with a push is not always what the call says; see
// "Gotchas for #28" in the spike doc:
//   - A progress push is dropped, with a 200, unless the position moved 15 s
//     or last_watched is 30 s newer than what is stored.
//   - An addons push replaces the whole list. Never send a partial one.
//   - Delta event IDs are one sequence across all users: opaque cursors.
//   - Our own writes come back in the delta feed.

// DeltaLimit is how many events one delta call asks for. A page shorter than
// this was the last.
const DeltaLimit = 1000

// Operation is what a delta event did to its row.
type Operation string

const (
	OpUpsert Operation = "upsert"
	OpDelete Operation = "delete"
)

// LibraryRow is a title in a profile's library. Times are ms since epoch.
type LibraryRow struct {
	ContentID    string   `json:"content_id"`
	ContentType  string   `json:"content_type"`
	Name         string   `json:"name"`
	Poster       string   `json:"poster,omitempty"`
	PosterShape  string   `json:"poster_shape,omitempty"`
	Background   string   `json:"background,omitempty"`
	Description  string   `json:"description,omitempty"`
	ReleaseInfo  string   `json:"release_info,omitempty"`
	IMDBRating   *float64 `json:"imdb_rating,omitempty"`
	Genres       []string `json:"genres,omitempty"`
	AddonBaseURL string   `json:"addon_base_url,omitempty"`
	AddedAt      int64    `json:"added_at"`
}

// LibraryEvent is one entry of the library delta feed. A delete event carries
// the row as it was.
type LibraryEvent struct {
	EventID   int64     `json:"event_id"`
	Operation Operation `json:"operation"`
	LibraryRow
}

// ProgressRow is how far a profile got in a film or episode. Positions and
// durations are ms, LastWatched ms since epoch. The server builds ProgressKey
// itself, so a push leaves it out.
type ProgressRow struct {
	ProgressKey string `json:"progress_key,omitempty"`
	ContentID   string `json:"content_id"`
	ContentType string `json:"content_type"`
	VideoID     string `json:"video_id"`
	Season      *int   `json:"season,omitempty"`
	Episode     *int   `json:"episode,omitempty"`
	Position    int64  `json:"position"`
	Duration    int64  `json:"duration"`
	LastWatched int64  `json:"last_watched"`
}

// ProgressEvent is one entry of the watch progress delta feed.
type ProgressEvent struct {
	EventID   int64     `json:"event_id"`
	Operation Operation `json:"operation"`
	ProgressRow
}

// WatchedRow marks a film, a series or an episode watched. WatchedAt is ms
// since epoch.
type WatchedRow struct {
	ContentID   string `json:"content_id"`
	ContentType string `json:"content_type"`
	Title       string `json:"title,omitempty"`
	Season      *int   `json:"season,omitempty"`
	Episode     *int   `json:"episode,omitempty"`
	WatchedAt   int64  `json:"watched_at"`
}

// WatchedEvent is one entry of the watched items delta feed.
type WatchedEvent struct {
	EventID   int64     `json:"event_id"`
	Operation Operation `json:"operation"`
	WatchedRow
}

// WatchedKey identifies a watched item to delete: a title, or an episode of
// it.
type WatchedKey struct {
	ContentID string `json:"content_id"`
	Season    *int   `json:"season,omitempty"`
	Episode   *int   `json:"episode,omitempty"`
}

// LibraryKey identifies a library item to delete.
type LibraryKey struct {
	ContentID   string `json:"content_id"`
	ContentType string `json:"content_type"`
}

// AddonRow is an installed addon. SortOrder is its place in the list.
type AddonRow struct {
	URL       string `json:"url"`
	Name      string `json:"name"`
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sort_order"`
}

// PluginRow is a plugin repository: Nuvio's plugins table lists repositories
// by manifest URL, not the plugins in them (#57). RepoType is "NUVIO_JS" for
// a repository of JS plugins and "EXTERNAL_DEX" for Android's Cloudstream
// ones; clients that predate the column leave it null.
type PluginRow struct {
	URL       string  `json:"url"`
	Name      *string `json:"name"`
	Enabled   bool    `json:"enabled"`
	SortOrder int     `json:"sort_order"`
	RepoType  *string `json:"repo_type"`
}

// delta calls one of the sync_pull_*_delta RPCs.
func delta[E any](c *Client, ctx context.Context, rpc string, s Session, index int, since int64) ([]E, error) {
	events := []E{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/"+rpc, s.AccessToken, map[string]any{
		"p_profile_id": index, "p_since_event_id": since, "p_limit": DeltaLimit,
	}, &events)
	return events, err
}

// LibraryDelta returns the library events after event ID since (0: from the
// start), oldest first, at most DeltaLimit of them.
func (c *Client) LibraryDelta(ctx context.Context, s Session, index int, since int64) ([]LibraryEvent, error) {
	return delta[LibraryEvent](c, ctx, "sync_pull_library_delta", s, index, since)
}

// ProgressDelta returns the watch progress events after since.
func (c *Client) ProgressDelta(ctx context.Context, s Session, index int, since int64) ([]ProgressEvent, error) {
	return delta[ProgressEvent](c, ctx, "sync_pull_watch_progress_delta", s, index, since)
}

// WatchedDelta returns the watched item events after since.
func (c *Client) WatchedDelta(ctx context.Context, s Session, index int, since int64) ([]WatchedEvent, error) {
	return delta[WatchedEvent](c, ctx, "sync_pull_watched_items_delta", s, index, since)
}

// The snapshot RPCs read a profile's whole current list, not its events. The
// delta feeds say what changed since a cursor; a snapshot says what is there
// now, which is how the syncer catches what a cursor already went past (a
// delete it once ignored, say).
const (
	// SnapshotPage is how many library items or watched items one snapshot
	// call asks for.
	SnapshotPage = 500
	// ProgressSnapshotLimit is how many progress entries the progress
	// snapshot asks for, in one call: the RPC has no offset. A profile with
	// this many is read as incomplete (see ProgressList).
	ProgressSnapshotLimit = 5000
)

// LibraryList returns every library item of profile index, in pages.
func (c *Client) LibraryList(ctx context.Context, s Session, index int) ([]LibraryRow, error) {
	all := []LibraryRow{}
	for offset := 0; ; offset += SnapshotPage {
		page := []LibraryRow{}
		err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_library", s.AccessToken, map[string]any{
			"p_profile_id": index, "p_limit": SnapshotPage, "p_offset": offset,
		}, &page)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < SnapshotPage {
			return all, nil
		}
	}
}

// ProgressList returns every progress entry of profile index. complete is
// false when the list reached ProgressSnapshotLimit, so there may be more.
func (c *Client) ProgressList(ctx context.Context, s Session, index int) (rows []ProgressRow, complete bool, err error) {
	rows = []ProgressRow{}
	err = c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_watch_progress", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_since_last_watched": 0, "p_limit": ProgressSnapshotLimit,
	}, &rows)
	return rows, len(rows) < ProgressSnapshotLimit, err
}

// WatchedList returns every watched item of profile index, in pages. Pages
// count from 1.
func (c *Client) WatchedList(ctx context.Context, s Session, index int) ([]WatchedRow, error) {
	all := []WatchedRow{}
	for page := 1; ; page++ {
		rows := []WatchedRow{}
		err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_watched_items", s.AccessToken, map[string]any{
			"p_profile_id": index, "p_page": page, "p_page_size": SnapshotPage,
		}, &rows)
		if err != nil {
			return nil, err
		}
		all = append(all, rows...)
		if len(rows) < SnapshotPage {
			return all, nil
		}
	}
}

// write calls one of the push and delete RPCs, which return nothing.
func (c *Client) write(ctx context.Context, rpc string, s Session, index int, arg string, rows any) error {
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/"+rpc, s.AccessToken, map[string]any{
		arg: rows, "p_profile_id": index, "p_origin_client_id": c.originID,
	}, nil)
}

// PushLibrary adds or updates library items.
func (c *Client) PushLibrary(ctx context.Context, s Session, index int, items []LibraryRow) error {
	return c.write(ctx, "sync_push_library_items", s, index, "p_items", items)
}

// DeleteLibrary removes library items.
func (c *Client) DeleteLibrary(ctx context.Context, s Session, index int, keys []LibraryKey) error {
	return c.write(ctx, "sync_delete_library_items", s, index, "p_keys", keys)
}

// PushProgress sends watch progress. The server drops an entry unless its
// position moved 15 s or its last_watched is 30 s newer than the stored one,
// and answers 200 either way, so a nil error doesn't mean it was stored.
func (c *Client) PushProgress(ctx context.Context, s Session, index int, entries []ProgressRow) error {
	return c.write(ctx, "sync_push_watch_progress", s, index, "p_entries", entries)
}

// DeleteProgress removes watch progress by progress key.
func (c *Client) DeleteProgress(ctx context.Context, s Session, index int, keys []string) error {
	return c.write(ctx, "sync_delete_watch_progress", s, index, "p_keys", keys)
}

// PushWatched marks items watched.
func (c *Client) PushWatched(ctx context.Context, s Session, index int, items []WatchedRow) error {
	return c.write(ctx, "sync_push_watched_items", s, index, "p_items", items)
}

// DeleteWatched removes watched marks.
func (c *Client) DeleteWatched(ctx context.Context, s Session, index int, keys []WatchedKey) error {
	return c.write(ctx, "sync_delete_watched_items", s, index, "p_keys", keys)
}

// Addons returns a profile's addons in order. There is no pull RPC: it reads
// the table, which row-level security limits to the account's own rows.
func (c *Client) Addons(ctx context.Context, s Session, index int) ([]AddonRow, error) {
	rows := []AddonRow{}
	query := url.Values{
		"select":     {"url,name,enabled,sort_order"},
		"profile_id": {"eq." + strconv.Itoa(index)},
		"order":      {"sort_order.asc"},
	}
	err := c.call(ctx, http.MethodGet, "/rest/v1/addons?"+query.Encode(), s.AccessToken, nil, &rows)
	return rows, err
}

// PushAddons replaces a profile's whole addon list with addons, in order. An
// empty list deletes every addon on the profile, so never push a partial
// list, or one from a stale cache.
func (c *Client) PushAddons(ctx context.Context, s Session, index int, addons []AddonRow) error {
	rows := make([]AddonRow, len(addons))
	for i, addon := range addons {
		addon.SortOrder = i
		rows[i] = addon
	}
	return c.write(ctx, "sync_push_addons", s, index, "p_addons", rows)
}

// Plugins returns a profile's plugin repositories in order. As with addons
// there is no pull RPC: it reads the table.
func (c *Client) Plugins(ctx context.Context, s Session, index int) ([]PluginRow, error) {
	rows := []PluginRow{}
	query := url.Values{
		"select":     {"url,name,enabled,sort_order,repo_type"},
		"profile_id": {"eq." + strconv.Itoa(index)},
		"order":      {"sort_order.asc"},
	}
	err := c.call(ctx, http.MethodGet, "/rest/v1/plugins?"+query.Encode(), s.AccessToken, nil, &rows)
	return rows, err
}

// PushPlugins replaces a profile's whole repository list with repos, in
// order. An empty list deletes every repository on the profile, so never push
// a partial list, or one from a stale cache.
func (c *Client) PushPlugins(ctx context.Context, s Session, index int, repos []PluginRow) error {
	rows := make([]PluginRow, len(repos))
	for i, repo := range repos {
		repo.SortOrder = i
		rows[i] = repo
	}
	return c.write(ctx, "sync_push_plugins", s, index, "p_plugins", rows)
}
