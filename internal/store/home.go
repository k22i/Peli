package store

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Home layout and collections (#35, F7, ADR-0022): which catalog rows Home
// shows, in what order, and the user's collections (named groups of
// catalogs, shown on Home as a row of folders). Both are made in Nuvio's
// apps and pulled whole. They are kept exactly as Nuvio's apps write them,
// so a push to a custom server doesn't drop what Peli doesn't read; the
// methods here read and edit the fields Peli knows.
//
// They are pushed to a custom server only, never to Nuvio's (the PRD's
// rule); the store queues a push for any linked profile, and the account
// service and the sync module refuse the rest.

const (
	SurfaceHomeLayout  Surface = "homeLayout"
	SurfaceCollections Surface = "collections"
)

var (
	keyHomeLayout  = []byte("home-layout")
	keyCollections = []byte("collections")
)

// HomeLayout is the order of Home's rows: catalogs of addons and
// collections. A catalog or collection it doesn't name goes after the ones
// it does.
type HomeLayout struct {
	Rows []HomeRow `json:"rows"`
	// Hide titles that aren't out yet.
	HideUnreleased bool `json:"hideUnreleased"`
}

// HomeRow is a row of Home: an addon's catalog, or a collection.
type HomeRow struct {
	// Nuvio's key for the row: "<addon id>:<type>:<catalog id>", or
	// "collection_<collection id>". Worked out from the rest if empty.
	Key string `json:"key"`
	// A catalog, by the addon's manifest id (not its URL, which is what
	// Addon has) and the catalog's type and id.
	AddonID   string `json:"addonId,omitempty"`
	Type      string `json:"type,omitempty"`
	CatalogID string `json:"catalogId,omitempty"`
	// Or a collection, by its id.
	CollectionID string `json:"collectionId,omitempty"`
	Enabled      bool   `json:"enabled"`
	// The title the user gave the row, if any.
	Title string `json:"title,omitempty"`
}

// Collection is a named group of folders, each a set of addon catalogs.
type Collection struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Shown before the layout's rows.
	PinToTop bool               `json:"pinToTop"`
	Backdrop string             `json:"backdrop,omitempty"`
	Folders  []CollectionFolder `json:"folders"`
}

// CollectionFolder is one tile of a collection.
type CollectionFolder struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	HideTitle bool   `json:"hideTitle"`
	// "POSTER", "LANDSCAPE" or "SQUARE", as Nuvio names them.
	Shape    string             `json:"shape,omitempty"`
	Cover    string             `json:"cover,omitempty"`
	Logo     string             `json:"logo,omitempty"`
	Emoji    string             `json:"emoji,omitempty"`
	Backdrop string             `json:"backdrop,omitempty"`
	Sources  []CollectionSource `json:"sources"`
}

// CollectionSource is an addon catalog a folder shows, by the addon's
// manifest id, optionally narrowed to a genre.
type CollectionSource struct {
	AddonID   string `json:"addonId"`
	Type      string `json:"type"`
	CatalogID string `json:"catalogId"`
	Genre     string `json:"genre,omitempty"`
}

// HomeLayout returns profile id's home layout, or nil if it has none.
func (s *Store) HomeLayout(id uint64) (*HomeLayout, error) {
	var layout *HomeLayout
	err := s.view(id, func(p *bolt.Bucket) error {
		data := p.Get(keyHomeLayout)
		if data == nil {
			return nil
		}
		var wire nuvioLayout
		if err := json.Unmarshal(data, &wire); err != nil {
			return err
		}
		layout = wire.layout()
		return nil
	})
	return layout, err
}

// SetHomeLayout replaces profile id's home layout and queues it for push.
// Rows are saved in the order given. What Nuvio's apps keep in the layout
// that Peli doesn't read is kept, row by row.
func (s *Store) SetHomeLayout(id uint64, layout HomeLayout) error {
	return s.update(id, func(p *bolt.Bucket) error {
		blob := map[string]json.RawMessage{}
		if data := p.Get(keyHomeLayout); data != nil {
			if err := json.Unmarshal(data, &blob); err != nil {
				return err
			}
		}
		var stored []map[string]json.RawMessage
		if raw, ok := blob["items"]; ok {
			if err := json.Unmarshal(raw, &stored); err != nil {
				return err
			}
		}
		byKey := map[string]map[string]json.RawMessage{}
		for _, item := range stored {
			var key string
			if json.Unmarshal(item["key"], &key) == nil {
				byKey[key] = item
			}
		}
		items := []map[string]json.RawMessage{}
		seen := map[string]bool{}
		for i, row := range layout.Rows {
			row.Key = cmp.Or(row.Key, row.defaultKey())
			if err := row.validate(); err != nil {
				return err
			}
			if seen[row.Key] {
				return fmt.Errorf("%w: home row %s is listed twice", ErrInvalidItem, row.Key)
			}
			seen[row.Key] = true
			item := map[string]json.RawMessage{}
			for k, v := range byKey[row.Key] {
				item[k] = v
			}
			for k, v := range map[string]any{
				"key": row.Key, "addon_id": row.AddonID, "type": row.Type, "catalog_id": row.CatalogID,
				"is_collection": row.CollectionID != "", "collection_id": row.CollectionID,
				"enabled": row.Enabled, "order": i, "custom_title": row.Title,
			} {
				item[k], _ = json.Marshal(v)
			}
			items = append(items, item)
		}
		blob["items"], _ = json.Marshal(items)
		blob["hide_unreleased_content"], _ = json.Marshal(layout.HideUnreleased)
		data, err := json.Marshal(blob)
		if err != nil {
			return err
		}
		return putBlob(p, SurfaceHomeLayout, keyHomeLayout, data)
	})
}

func (r HomeRow) defaultKey() string {
	if r.CollectionID != "" {
		return "collection_" + r.CollectionID
	}
	return r.AddonID + ":" + r.Type + ":" + r.CatalogID
}

func (r HomeRow) validate() error {
	catalog := r.AddonID != "" || r.Type != "" || r.CatalogID != ""
	switch {
	case r.CollectionID != "" && catalog:
		return fmt.Errorf("%w: home row %s is both a catalog and a collection", ErrInvalidItem, r.Key)
	case r.CollectionID == "" && (r.AddonID == "" || r.Type == "" || r.CatalogID == ""):
		return fmt.Errorf("%w: home row %s needs an addon, a type and a catalog, or a collection", ErrInvalidItem, r.Key)
	}
	return nil
}

// Collections returns profile id's collections in order.
func (s *Store) Collections(id uint64) ([]Collection, error) {
	collections := []Collection{}
	err := s.view(id, func(p *bolt.Bucket) error {
		data := p.Get(keyCollections)
		if data == nil {
			return nil
		}
		var wire []nuvioCollection
		if err := json.Unmarshal(data, &wire); err != nil {
			return err
		}
		for _, c := range wire {
			collections = append(collections, c.collection())
		}
		return nil
	})
	return collections, err
}

// VisibleCollections returns the collections profile id may see on Home:
// all of them, or none for a kids profile. A collection names addons by
// manifest id, which a kids scope (by manifest URL) can't be checked against
// until the addon client reads manifests (#37), and a kids scope is an
// allow-list.
func (s *Store) VisibleCollections(id uint64) ([]Collection, error) {
	profile, err := s.Profile(id)
	if err != nil {
		return nil, err
	}
	if profile.Kids {
		return []Collection{}, nil
	}
	return s.Collections(id)
}

// SetCollections replaces profile id's collections with collections, a JSON
// array as Nuvio's apps write it, and queues it for push. Each collection
// needs an id. It isn't bound for the frontend: Peli has no collection
// editor yet, and an edit must go through the account service's check that
// the backend is a custom server.
func (s *Store) SetCollections(id uint64, collections json.RawMessage) error {
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(collections, &list); err != nil {
		return fmt.Errorf("%w: collections: %v", ErrInvalidItem, err)
	}
	seen := map[string]bool{}
	for _, c := range list {
		var cid string
		if json.Unmarshal(c["id"], &cid) != nil || cid == "" || seen[cid] {
			return fmt.Errorf("%w: a collection's id is missing or listed twice", ErrInvalidItem)
		}
		seen[cid] = true
	}
	data, err := canonicalJSON(collections)
	if err != nil {
		return err
	}
	return s.update(id, func(p *bolt.Bucket) error { return putBlob(p, SurfaceCollections, keyCollections, data) })
}

// putBlob stores a home layout or collections blob and queues it for push,
// unless it is what is stored already. The outbox keeps one push per
// surface: the newest blob.
func putBlob(p *bolt.Bucket, surface Surface, key, data []byte) error {
	data, err := canonicalJSON(data)
	if err != nil {
		return err
	}
	if bytes.Equal(p.Get(key), data) {
		return nil
	}
	if err := p.Put(key, data); err != nil {
		return err
	}
	return queue(p, Push{Surface: surface, Op: OpUpsert, Item: data})
}

// canonicalJSON rewrites data with object keys sorted and no spaces, so the
// same blob from Nuvio's apps and from Peli compares equal byte for byte.
// Numbers keep their digits.
func canonicalJSON(data []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// nuvioLayout is the part of Nuvio's layout blob Peli reads.
type nuvioLayout struct {
	Items          []nuvioLayoutItem `json:"items"`
	HideUnreleased bool              `json:"hide_unreleased_content"`
}

type nuvioLayoutItem struct {
	Key          string `json:"key"`
	AddonID      string `json:"addon_id"`
	Type         string `json:"type"`
	CatalogID    string `json:"catalog_id"`
	Enabled      *bool  `json:"enabled"`
	Order        int    `json:"order"`
	CustomTitle  string `json:"custom_title"`
	IsCollection bool   `json:"is_collection"`
	CollectionID string `json:"collection_id"`
}

// layout reads the rows in Nuvio's order (by "order", then as listed).
func (w nuvioLayout) layout() *HomeLayout {
	items := slices.Clone(w.Items)
	slices.SortStableFunc(items, func(a, b nuvioLayoutItem) int {
		return cmp.Compare(a.Order, b.Order)
	})
	layout := &HomeLayout{Rows: []HomeRow{}, HideUnreleased: w.HideUnreleased}
	for _, item := range items {
		row := HomeRow{Key: item.Key, Enabled: item.Enabled == nil || *item.Enabled, Title: strings.TrimSpace(item.CustomTitle)}
		if item.IsCollection {
			row.CollectionID = item.CollectionID
		} else {
			row.AddonID, row.Type, row.CatalogID = item.AddonID, item.Type, item.CatalogID
		}
		row.Key = cmp.Or(row.Key, row.defaultKey())
		if row.validate() == nil {
			layout.Rows = append(layout.Rows, row)
		}
	}
	return layout
}

// nuvioCollection is the part of a collection in Nuvio's blob Peli reads.
type nuvioCollection struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	PinToTop bool   `json:"pinToTop"`
	Backdrop string `json:"backdropImageUrl"`
	Folders  []struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		HideTitle bool   `json:"hideTitle"`
		TileShape string `json:"tileShape"`
		Cover     string `json:"coverImageUrl"`
		Logo      string `json:"titleLogoUrl"`
		Emoji     string `json:"coverEmoji"`
		Backdrop  string `json:"heroBackdropUrl"`
		Sources   []struct {
			Provider  string  `json:"provider"`
			AddonID   string  `json:"addonId"`
			Type      string  `json:"type"`
			CatalogID string  `json:"catalogId"`
			Genre     *string `json:"genre"`
		} `json:"sources"`
		// The older form of sources, without a provider.
		CatalogSources []struct {
			AddonID   string  `json:"addonId"`
			Type      string  `json:"type"`
			CatalogID string  `json:"catalogId"`
			Genre     *string `json:"genre"`
		} `json:"catalogSources"`
	} `json:"folders"`
}

func (w nuvioCollection) collection() Collection {
	c := Collection{ID: w.ID, Title: w.Title, PinToTop: w.PinToTop, Backdrop: w.Backdrop, Folders: []CollectionFolder{}}
	for _, f := range w.Folders {
		folder := CollectionFolder{
			ID: f.ID, Title: f.Title, HideTitle: f.HideTitle, Shape: f.TileShape,
			Cover: f.Cover, Logo: f.Logo, Emoji: f.Emoji, Backdrop: f.Backdrop, Sources: []CollectionSource{},
		}
		for _, src := range f.Sources {
			// Other providers (Trakt lists, say) aren't addon catalogs.
			if src.Provider == "" || src.Provider == "addon" {
				folder.Sources = append(folder.Sources, CollectionSource{src.AddonID, src.Type, src.CatalogID, genre(src.Genre)})
			}
		}
		if len(f.Sources) == 0 {
			for _, src := range f.CatalogSources {
				folder.Sources = append(folder.Sources, CollectionSource{src.AddonID, src.Type, src.CatalogID, genre(src.Genre)})
			}
		}
		c.Folders = append(c.Folders, folder)
	}
	return c
}

// genre reads a source's genre: Nuvio's apps write "None" or "" for none.
func genre(g *string) string {
	if g == nil || *g == "None" {
		return ""
	}
	return *g
}
