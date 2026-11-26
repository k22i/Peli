package nuviotest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// The fake's library, watch progress, watched items, addons (#28), plugin
// repositories (#57), and
// home layouts and collections (#35, home.go). They
// behave as docs/spikes/nuvio-backend.md saw them:
//   - Event IDs are one sequence for the whole backend, starting high and
//     skipping numbers, and every write is in the feed, our own too, with no
//     origin client.
//   - A progress push is dropped, with a 200, unless the position moved 15 s
//     or last_watched is 30 s newer than the stored one.
//   - Progress of 90 % or more of an item over a minute adds a watched item.
//   - An addons or plugins push replaces the whole list.
//   - Every push must send p_origin_client_id, or the call matches no
//     function (PGRST202).

// firstEventID is where the event sequence starts: live's was past 242 million.
const firstEventID = 242_369_000

// A surface name for Rows and the event feeds.
const (
	Library  = "library"
	Progress = "progress"
	Watched  = "watched"
)

type profileKey struct {
	user  string
	index int
}

type rowKey struct {
	profileKey
	key string
}

// event is one entry of a delta feed. row is the row after the change, or as
// it was for a delete.
type event struct {
	id      int64
	profile profileKey
	op      string
	row     map[string]any
}

// syncState is what the sync RPCs read and write. The server's mutex guards it.
type syncState struct {
	next      int64
	rows      map[string]map[rowKey]map[string]any // by surface
	events    map[string][]event
	addons    map[profileKey][]map[string]any
	plugins   map[profileKey][]map[string]any // plugin repositories (#57)
	home      map[homeKey]map[string]any      // home layouts (home.go)
	colls     map[profileKey][]any            // collections (home.go)
	blobs     map[blobKey]blobRow             // settings blobs (settings.go)
	blobClock int
	pushes    map[string]int // pushes received, by RPC name
	dropped   int            // progress entries dropped by the throttle
}

func newSyncState() *syncState {
	return &syncState{
		next:    firstEventID,
		rows:    map[string]map[rowKey]map[string]any{Library: {}, Progress: {}, Watched: {}},
		events:  map[string][]event{},
		addons:  map[profileKey][]map[string]any{},
		plugins: map[profileKey][]map[string]any{},
		home:    map[homeKey]map[string]any{},
		colls:   map[profileKey][]any{},
		blobs:   map[blobKey]blobRow{},
		pushes:  map[string]int{},
	}
}

// Rows returns the rows of an account's profile on surface (Library,
// Progress or Watched), as the server stores them, ordered by key.
func (s *Server) Rows(email string, index int, surface string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	profile := profileKey{UserID(email), index}
	var keys []string
	byKey := map[string]map[string]any{}
	for k, row := range s.sync.rows[surface] {
		if k.profileKey == profile {
			keys = append(keys, k.key)
			byKey[k.key] = row
		}
	}
	slices.Sort(keys)
	rows := []map[string]any{}
	for _, k := range keys {
		rows = append(rows, byKey[k])
	}
	return rows
}

// SyncedAddons returns the addons of an account's profile, in order.
func (s *Server) SyncedAddons(email string, index int) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any{}, s.sync.addons[profileKey{UserID(email), index}]...)
}

// SyncedPlugins returns the plugin repositories of an account's profile, in
// order, as the server stores them (#57).
func (s *Server) SyncedPlugins(email string, index int) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any{}, s.sync.plugins[profileKey{UserID(email), index}]...)
}

// Pushes returns how many times the RPC (such as "sync_push_watch_progress")
// was called, and DroppedProgress how many progress entries the throttle
// dropped.
func (s *Server) Pushes(rpc string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sync.pushes[rpc]
}

func (s *Server) DroppedProgress() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sync.dropped
}

// syncRoutes answers the sync RPCs and the addons table, and reports whether
// path is one of them. s.mu is held.
func (s *Server) syncRoutes(w http.ResponseWriter, r *http.Request, user string, body map[string]any) bool {
	path := r.URL.Path
	if path == "/rest/v1/addons" {
		s.readAddons(w, user, r.URL.Query())
		return true
	}
	if path == "/rest/v1/plugins" {
		s.readPlugins(w, user, r.URL.Query())
		return true
	}
	if path == "/rest/v1/profile_settings_blobs" {
		s.settingsTable(w, r, user)
		return true
	}
	rpc, ok := strings.CutPrefix(path, "/rest/v1/rpc/")
	if !ok || !isSyncRPC(rpc) {
		return false
	}
	if user == "" {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `{"code":"42501","message":"permission denied for function %s"}`, rpc)
		return true
	}
	// PostgREST picks a function by its argument names: one it doesn't
	// take, or a push or delete without the origin client, matches none.
	args := syncArgs[rpc]
	_, origin := body["p_origin_client_id"]
	matches := origin || !slices.Contains(args, "p_origin_client_id")
	for k := range body {
		matches = matches && slices.Contains(args, k)
	}
	if !matches {
		postgrestError(w, http.StatusNotFound, "PGRST202", "Could not find the function public."+rpc+" in the schema cache")
		return true
	}
	if _, ok := body["p_profile_id"].(float64); !ok {
		postgrestError(w, http.StatusBadRequest, "22P02", fmt.Sprintf("invalid input syntax for type integer: %q", fmt.Sprint(body["p_profile_id"])))
		return true
	}
	index := int(number(body["p_profile_id"]))
	profile := profileKey{user, index}
	st := s.sync

	if feed, ok := feeds[rpc]; ok {
		// A pull reads rows, so a profile that can't exist has none.
		s.deltaFeed(w, profile, feed, body)
		return true
	}
	if s.snapshot(w, rpc, profile, body) {
		return true
	}
	if s.pullHome(w, rpc, profile, body) {
		return true
	}
	switch rpc {
	case "sync_pull_profile_settings_blob", "sync_push_profile_settings_blob", "sync_push_profile_settings_blob_guarded":
		s.settingsRPC(w, rpc, profile, body)
		return true
	}
	if index < 1 || index > 6 {
		postgrestError(w, http.StatusBadRequest, "P0001", "Invalid profile id")
		return true
	}
	st.pushes[rpc]++
	switch rpc {
	case "sync_push_library_items":
		for _, item := range list(body["p_items"]) {
			s.putLibrary(profile, item)
		}
	case "sync_delete_library_items":
		for _, key := range list(body["p_keys"]) {
			s.deleteRow(Library, profile, str(key["content_id"])+"|"+str(key["content_type"]))
		}
	case "sync_push_watch_progress":
		for _, entry := range list(body["p_entries"]) {
			s.putProgress(profile, entry)
		}
	case "sync_delete_watch_progress":
		keys, _ := body["p_keys"].([]any)
		for _, key := range keys {
			s.deleteRow(Progress, profile, fmt.Sprint(key))
		}
	case "sync_push_watched_items":
		for _, item := range list(body["p_items"]) {
			s.putWatched(profile, item, "watched")
		}
	case "sync_delete_watched_items":
		for _, key := range list(body["p_keys"]) {
			s.deleteRow(Watched, profile, watchedID(str(key["content_id"]), key["season"], key["episode"]))
		}
	case "sync_push_addons":
		addons := []map[string]any{}
		for i, a := range list(body["p_addons"]) {
			addons = append(addons, map[string]any{
				"url": a["url"], "name": a["name"], "enabled": a["enabled"], "sort_order": i,
			})
		}
		st.addons[profile] = addons
	case "sync_push_plugins":
		plugins := []map[string]any{}
		for i, p := range list(body["p_plugins"]) {
			// Like the table: a client that leaves out enabled gets true.
			enabled, ok := p["enabled"]
			if !ok {
				enabled = true
			}
			plugins = append(plugins, map[string]any{
				"url": p["url"], "name": p["name"], "enabled": enabled, "sort_order": i, "repo_type": p["repo_type"],
			})
		}
		st.plugins[profile] = plugins
	case "sync_push_home_catalog_settings", "sync_push_collections":
		s.pushHome(rpc, profile, body)
	}
	w.WriteHeader(http.StatusNoContent)
	return true
}

// feeds maps the delta RPCs to their surface.
var feeds = map[string]string{
	"sync_pull_library_delta":        Library,
	"sync_pull_watch_progress_delta": Progress,
	"sync_pull_watched_items_delta":  Watched,
}

// syncArgs is the arguments each sync RPC takes, as self-host defines them.
var syncArgs = map[string][]string{
	"sync_pull_library_delta":        {"p_since_event_id", "p_profile_id", "p_limit"},
	"sync_pull_watch_progress_delta": {"p_since_event_id", "p_profile_id", "p_limit"},
	"sync_pull_watched_items_delta":  {"p_since_event_id", "p_profile_id", "p_limit"},
	"sync_pull_library":              {"p_profile_id", "p_limit", "p_offset"},
	"sync_pull_watch_progress":       {"p_profile_id", "p_since_last_watched", "p_limit"},
	"sync_pull_watched_items":        {"p_profile_id", "p_page", "p_page_size"},
	"sync_push_library_items":        {"p_items", "p_profile_id", "p_origin_client_id"},
	"sync_delete_library_items":      {"p_keys", "p_profile_id", "p_origin_client_id"},
	"sync_push_watch_progress":       {"p_entries", "p_profile_id", "p_origin_client_id"},
	"sync_delete_watch_progress":     {"p_keys", "p_profile_id", "p_origin_client_id"},
	"sync_push_watched_items":        {"p_items", "p_profile_id", "p_origin_client_id"},
	"sync_delete_watched_items":      {"p_keys", "p_profile_id", "p_origin_client_id"},
	"sync_push_addons":               {"p_addons", "p_profile_id", "p_origin_client_id"},
	"sync_push_plugins":              {"p_plugins", "p_profile_id", "p_origin_client_id"},

	"sync_pull_home_catalog_settings":         {"p_profile_id", "p_platform"},
	"sync_push_home_catalog_settings":         {"p_profile_id", "p_settings_json", "p_platform", "p_origin_client_id"},
	"sync_pull_profile_settings_blob":         {"p_profile_id", "p_platform"},
	"sync_push_profile_settings_blob":         {"p_profile_id", "p_platform", "p_settings_json", "p_origin_client_id"},
	"sync_push_profile_settings_blob_guarded": {"p_profile_id", "p_platform", "p_settings_json", "p_expected_updated_at"},
	"sync_pull_collections":                   {"p_profile_id"},
	"sync_push_collections":                   {"p_profile_id", "p_collections_json", "p_origin_client_id"},
}

func isSyncRPC(rpc string) bool {
	_, ok := syncArgs[rpc]
	return ok
}

func (s *Server) record(surface string, profile profileKey, op string, row map[string]any) {
	s.sync.next += 1 + int64(len(s.sync.events[surface])%3) // gaps are normal
	s.sync.events[surface] = append(s.sync.events[surface], event{s.sync.next, profile, op, row})
}

func (s *Server) putRow(surface string, profile profileKey, key string, row map[string]any) {
	s.sync.rows[surface][rowKey{profile, key}] = row
	s.record(surface, profile, "upsert", row)
}

func (s *Server) deleteRow(surface string, profile profileKey, key string) {
	k := rowKey{profile, key}
	if row, ok := s.sync.rows[surface][k]; ok {
		delete(s.sync.rows[surface], k)
		s.record(surface, profile, "delete", row)
	}
}

func (s *Server) putLibrary(profile profileKey, item map[string]any) {
	if str(item["content_id"]) == "" || str(item["content_type"]) == "" {
		return
	}
	shape := str(item["poster_shape"])
	if shape == "" {
		shape = "POSTER"
	}
	row := map[string]any{
		"content_id": item["content_id"], "content_type": item["content_type"], "name": str(item["name"]),
		"poster": item["poster"], "poster_shape": shape, "background": item["background"],
		"description": item["description"], "release_info": item["release_info"],
		"imdb_rating": item["imdb_rating"], "genres": orEmpty(item["genres"]),
		"addon_base_url": item["addon_base_url"], "added_at": number(item["added_at"]),
	}
	s.putRow(Library, profile, str(row["content_id"])+"|"+str(row["content_type"]), row)
}

func progressKey(contentID string, season, episode any) string {
	if season == nil || episode == nil {
		return contentID
	}
	return fmt.Sprintf("%s_s%.0fe%.0f", contentID, number(season), number(episode))
}

func (s *Server) putProgress(profile profileKey, entry map[string]any) {
	id := str(entry["content_id"])
	if id == "" {
		return
	}
	key := progressKey(id, entry["season"], entry["episode"])
	row := map[string]any{
		"progress_key": key, "content_id": id, "content_type": entry["content_type"],
		"video_id": entry["video_id"], "season": entry["season"], "episode": entry["episode"],
		"position": number(entry["position"]), "duration": number(entry["duration"]),
		"last_watched": number(entry["last_watched"]),
	}
	if old, ok := s.sync.rows[Progress][rowKey{profile, key}]; ok {
		moved := number(row["position"]) - number(old["position"])
		newer := number(row["last_watched"]) - number(old["last_watched"])
		if moved < 15_000 && moved > -15_000 && newer < 30_000 {
			s.sync.dropped++
			return
		}
	}
	s.putRow(Progress, profile, key, row)
	if d := number(row["duration"]); d >= 60_000 && number(row["position"])*10 >= d*9 {
		s.putWatched(profile, map[string]any{
			"content_id": id, "content_type": row["content_type"], "season": row["season"],
			"episode": row["episode"], "watched_at": row["last_watched"],
		}, "progress")
	}
}

func watchedID(contentID string, season, episode any) string {
	n := func(v any) string {
		if v == nil {
			return "-1"
		}
		return strconv.Itoa(int(number(v)))
	}
	return contentID + "|" + n(season) + "|" + n(episode)
}

func (s *Server) putWatched(profile profileKey, item map[string]any, _ string) {
	if str(item["content_id"]) == "" {
		return
	}
	kind := str(item["content_type"])
	if kind == "" {
		kind = "movie"
	}
	row := map[string]any{
		"content_id": item["content_id"], "content_type": kind, "title": str(item["title"]),
		"season": item["season"], "episode": item["episode"], "watched_at": number(item["watched_at"]),
	}
	s.putRow(Watched, profile, watchedID(str(item["content_id"]), item["season"], item["episode"]), row)
}

// deltaFeed answers sync_pull_*_delta: the profile's events after
// p_since_event_id, oldest first, at most p_limit.
func (s *Server) deltaFeed(w http.ResponseWriter, profile profileKey, surface string, body map[string]any) {
	since := int64(number(body["p_since_event_id"]))
	limit := int(number(body["p_limit"]))
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	out := []map[string]any{}
	for _, e := range s.sync.events[surface] {
		if e.profile != profile || e.id <= since {
			continue
		}
		row := map[string]any{"event_id": e.id, "operation": e.op}
		for k, v := range e.row {
			row[k] = v
		}
		out = append(out, row)
		if len(out) == limit {
			break
		}
	}
	json.NewEncoder(w).Encode(out)
}

// snapshots maps the snapshot RPCs to their surface.
var snapshots = map[string]string{
	"sync_pull_library":        Library,
	"sync_pull_watch_progress": Progress,
	"sync_pull_watched_items":  Watched,
}

// snapshot answers the sync_pull_* list RPCs: the profile's rows now, in key
// order, a page of them. Library pages by p_limit and p_offset, watched items
// by p_page (from 1) and p_page_size, and progress takes only p_limit. It
// reports whether rpc was one of them. s.mu is held.
func (s *Server) snapshot(w http.ResponseWriter, rpc string, profile profileKey, body map[string]any) bool {
	surface, ok := snapshots[rpc]
	if !ok {
		return false
	}
	var keys []string
	byKey := map[string]map[string]any{}
	for k, row := range s.sync.rows[surface] {
		if k.profileKey == profile {
			keys = append(keys, k.key)
			byKey[k.key] = row
		}
	}
	slices.Sort(keys)
	offset, limit := 0, len(keys)
	switch surface {
	case Library:
		offset, limit = int(number(body["p_offset"])), int(number(body["p_limit"]))
	case Progress:
		limit = int(number(body["p_limit"]))
	case Watched:
		size := int(number(body["p_page_size"]))
		page := int(number(body["p_page"]))
		if page < 1 {
			postgrestError(w, http.StatusBadRequest, "2201X", "OFFSET must not be negative")
			return true
		}
		offset, limit = (page-1)*size, size
	}
	if limit <= 0 {
		limit = len(keys)
	}
	out := []map[string]any{}
	for i := offset; i < len(keys) && len(out) < limit; i++ {
		out = append(out, byKey[keys[i]])
	}
	json.NewEncoder(w).Encode(out)
	return true
}

// readAddons answers GET /rest/v1/addons?profile_id=eq.N&order=sort_order.asc,
// which row-level security limits to the account's rows.
func (s *Server) readAddons(w http.ResponseWriter, user string, query url.Values) {
	if user == "" {
		// PostgREST reads the table as the anonymous role: no rows.
		w.Write([]byte(`[]`))
		return
	}
	index, _ := strconv.Atoi(strings.TrimPrefix(query.Get("profile_id"), "eq."))
	json.NewEncoder(w).Encode(append([]map[string]any{}, s.sync.addons[profileKey{user, index}]...))
}

// readPlugins answers GET /rest/v1/plugins?profile_id=eq.N&order=sort_order.asc
// the way readAddons does (#57).
func (s *Server) readPlugins(w http.ResponseWriter, user string, query url.Values) {
	if user == "" {
		w.Write([]byte(`[]`))
		return
	}
	index, _ := strconv.Atoi(strings.TrimPrefix(query.Get("profile_id"), "eq."))
	json.NewEncoder(w).Encode(append([]map[string]any{}, s.sync.plugins[profileKey{user, index}]...))
}

func number(v any) float64 {
	f, _ := v.(float64)
	return f
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func orEmpty(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

// list reads a JSON array of objects.
func list(v any) []map[string]any {
	var out []map[string]any
	items, _ := v.([]any)
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
