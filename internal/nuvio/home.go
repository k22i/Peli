package nuvio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Home layout and collections (#35, F7). Nuvio's apps keep both per profile
// as a JSON blob the server stores without looking inside:
//   - The home layout is sync_*_home_catalog_settings' settings_json, under
//     the platform homePlatform, which Nuvio's TV and mobile apps share:
//     {items: [{key, addon_id, type, catalog_id, enabled, order,
//     custom_title, is_collection, collection_id}], hide_unreleased_content,
//     …}. The "desktop" platform has no rows.
//   - Collections are sync_*_collections' collections_json: an array of
//     {id, title, folders: [{id, title, sources, tileShape, …}], pinToTop,
//     viewMode, …}.
//
// The PRD forbids pushing either to Nuvio's own backend, so the push calls
// work only on a custom server (#34): the client refuses before it sends
// anything while it points at the URL it was made with or at a nuvio.tv
// host. Pulling is allowed everywhere.

// ErrNuviosServer means a home layout or collections push was refused
// because the client points at Nuvio's server.
var ErrNuviosServer = errors.New("nuvio: home layout and collections are never pushed to Nuvio's server")

// homePlatform is the platform Nuvio's apps share one home layout under.
const homePlatform = "home_catalog_shared"

// HomeLayoutRow is a profile's home layout as the server keeps it.
type HomeLayoutRow struct {
	ProfileID int `json:"profile_id"`
	// Nuvio's apps' blob, passed through whole so a push keeps what Peli
	// doesn't read.
	Settings map[string]json.RawMessage `json:"settings_json"`
}

// CollectionsRow is a profile's collections as the server keeps them.
type CollectionsRow struct {
	ProfileID   int              `json:"profile_id"`
	Collections []map[string]any `json:"collections_json"`
}

// OwnServer reports whether the client points at a custom server: neither
// the URL it was made with (Nuvio's, or $PELI_NUVIO_URL in development) nor
// any nuvio.tv host.
func (c *Client) OwnServer() bool {
	base, _ := c.server()
	return base != c.home && !nuvioHost(base)
}

func nuvioHost(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return true // can't tell, so don't push
	}
	host := strings.ToLower(u.Hostname())
	return host == "nuvio.tv" || strings.HasSuffix(host, ".nuvio.tv")
}

// HomeLayout returns a profile's home layout, or nil if it has none.
func (c *Client) HomeLayout(ctx context.Context, s Session, index int) (map[string]json.RawMessage, error) {
	rows := []HomeLayoutRow{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_home_catalog_settings", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_platform": homePlatform,
	}, &rows)
	if err != nil || len(rows) == 0 || rows[0].Settings == nil {
		return nil, err
	}
	return rows[0].Settings, nil
}

// Collections returns a profile's collections, or nil if it has none.
func (c *Client) Collections(ctx context.Context, s Session, index int) ([]map[string]any, error) {
	rows := []CollectionsRow{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_collections", s.AccessToken, map[string]any{
		"p_profile_id": index,
	}, &rows)
	if err != nil || len(rows) == 0 || rows[0].Collections == nil {
		return nil, err
	}
	return rows[0].Collections, nil
}

// PushHomeLayout replaces a profile's home layout with settings, on a
// custom server only (ErrNuviosServer).
func (c *Client) PushHomeLayout(ctx context.Context, s Session, index int, settings json.RawMessage) error {
	if !c.OwnServer() {
		return ErrNuviosServer
	}
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_push_home_catalog_settings", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_settings_json": settings, "p_platform": homePlatform, "p_origin_client_id": c.originID,
	}, nil)
}

// PushCollections replaces a profile's collections with collections, a JSON
// array, on a custom server only (ErrNuviosServer).
func (c *Client) PushCollections(ctx context.Context, s Session, index int, collections json.RawMessage) error {
	if !c.OwnServer() {
		return ErrNuviosServer
	}
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_push_collections", s.AccessToken, map[string]any{
		"p_profile_id": index, "p_collections_json": collections, "p_origin_client_id": c.originID,
	}, nil)
}
