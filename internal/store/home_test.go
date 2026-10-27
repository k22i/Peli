package store

import (
	"encoding/json"
	"errors"
	"testing"
)

// A layout as Nuvio's apps write it, with fields Sinag doesn't read.
const nuvioLayoutJSON = `{
	"items": [
		{"key": "collection_c1", "type": "", "order": 2, "enabled": true, "addon_id": "", "catalog_id": "", "custom_title": "", "collection_id": "c1", "is_collection": true},
		{"key": "org.cinemeta:movie:top", "type": "movie", "order": 0, "enabled": true, "addon_id": "org.cinemeta", "catalog_id": "top", "custom_title": "Popular", "collection_id": "", "is_collection": false, "tint": "blue"},
		{"key": "org.cinemeta:series:top", "type": "series", "order": 1, "enabled": false, "addon_id": "org.cinemeta", "catalog_id": "top", "custom_title": "", "collection_id": "", "is_collection": false}
	],
	"hide_unreleased_content": true,
	"hide_catalog_underline": true
}`

const nuvioCollectionsJSON = `[{
	"id": "c1", "title": "Streaming", "pinToTop": false, "viewMode": "FOLLOW_LAYOUT", "backdropImageUrl": "https://img.example/c1.jpg",
	"folders": [{
		"id": "f1", "title": "Netflix", "hideTitle": true, "tileShape": "LANDSCAPE", "coverImageUrl": "https://img.example/netflix.jpg",
		"titleLogoUrl": null, "coverEmoji": null, "focusGifEnabled": false,
		"sources": [
			{"type": "movie", "genre": "None", "addonId": "community.streaming", "provider": "addon", "catalogId": "nfx"},
			{"type": "series", "genre": "Drama", "addonId": "community.streaming", "provider": "addon", "catalogId": "nfx"},
			{"type": "movie", "listId": "trakt-1", "provider": "trakt"}
		],
		"catalogSources": [{"type": "movie", "genre": null, "addonId": "community.streaming", "catalogId": "nfx"}]
	}, {
		"id": "f2", "title": "Older", "tileShape": "POSTER",
		"catalogSources": [{"type": "movie", "genre": null, "addonId": "org.cinemeta", "catalogId": "top"}]
	}]
}]`

func TestHomeLayoutFromNuvio(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	if got := must[*HomeLayout](t)(s.HomeLayout(linked.ID)); got != nil {
		t.Fatalf("a new profile has layout %+v", got)
	}

	applied := must[int](t)(s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceHomeLayout, Op: OpUpsert, Item: json.RawMessage(nuvioLayoutJSON)}}))
	if applied != 1 {
		t.Fatalf("applied %d", applied)
	}
	equal(t, *must[*HomeLayout](t)(s.HomeLayout(linked.ID)), HomeLayout{
		Rows: []HomeRow{
			{Key: "org.cinemeta:movie:top", AddonID: "org.cinemeta", Type: "movie", CatalogID: "top", Enabled: true, Title: "Popular"},
			{Key: "org.cinemeta:series:top", AddonID: "org.cinemeta", Type: "series", CatalogID: "top"},
			{Key: "collection_c1", CollectionID: "c1", Enabled: true},
		},
		HideUnreleased: true,
	})
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})

	// Again, reformatted: nothing changes.
	var v any
	check(t, json.Unmarshal([]byte(nuvioLayoutJSON), &v))
	again, _ := json.MarshalIndent(v, "", "    ")
	if n := must[int](t)(s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceHomeLayout, Op: OpUpsert, Item: again}})); n != 0 {
		t.Fatalf("the same layout applied %d changes", n)
	}
	// The backend having none removes it.
	if n := must[int](t)(s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceHomeLayout, Op: OpDelete, Item: json.RawMessage("null")}})); n != 1 {
		t.Fatalf("delete applied %d", n)
	}
	if got := must[*HomeLayout](t)(s.HomeLayout(linked.ID)); got != nil {
		t.Fatalf("after a delete: %+v", got)
	}

	_, err := s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceHomeLayout, Op: OpUpsert, Item: json.RawMessage(`[]`)}})
	if !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("an array as a layout: err = %v", err)
	}
}

// An edit keeps what Nuvio's apps wrote that Sinag doesn't read, and queues
// the whole blob.
func TestSetHomeLayout(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := linked.ID
	must[int](t)(s.ApplyChanges(id, []Change{{Surface: SurfaceHomeLayout, Op: OpUpsert, Item: json.RawMessage(nuvioLayoutJSON)}}))

	layout := *must[*HomeLayout](t)(s.HomeLayout(id))
	// Collection first, the series row on, the film row's title gone, and a
	// new row.
	layout.Rows = []HomeRow{layout.Rows[2], layout.Rows[1], layout.Rows[0], {AddonID: "community.anime", Type: "anime", CatalogID: "new", Enabled: true}}
	layout.Rows[1].Enabled = true
	layout.Rows[2].Title = ""
	layout.HideUnreleased = false
	check(t, s.SetHomeLayout(id, layout))

	pending := must[[]Push](t)(s.Pending(id))
	if len(pending) != 1 || pending[0].Surface != SurfaceHomeLayout || pending[0].Op != OpUpsert {
		t.Fatalf("pending = %+v", pending)
	}
	var blob struct {
		Items []map[string]any `json:"items"`
		Hide  bool             `json:"hide_unreleased_content"`
		Line  bool             `json:"hide_catalog_underline"`
	}
	check(t, json.Unmarshal(pending[0].Item, &blob))
	if blob.Hide || !blob.Line || len(blob.Items) != 4 {
		t.Fatalf("pushed %s", pending[0].Item)
	}
	for i, want := range []string{"collection_c1", "org.cinemeta:series:top", "org.cinemeta:movie:top", "community.anime:anime:new"} {
		if blob.Items[i]["key"] != want || blob.Items[i]["order"] != float64(i) {
			t.Fatalf("item %d = %v, want %s at order %d", i, blob.Items[i], want, i)
		}
	}
	if blob.Items[2]["tint"] != "blue" || blob.Items[2]["custom_title"] != "" || blob.Items[3]["is_collection"] != false {
		t.Fatalf("items = %v", blob.Items)
	}
	got := *must[*HomeLayout](t)(s.HomeLayout(id))
	layout.Rows[3].Key = "community.anime:anime:new"
	equal(t, got, layout)

	// The same layout again queues nothing new.
	check(t, s.AckPush(id, pending[0]))
	check(t, s.SetHomeLayout(id, got))
	equal(t, must[[]Push](t)(s.Pending(id)), []Push{})

	for _, bad := range []HomeRow{
		{AddonID: "a", Type: "movie"},
		{AddonID: "a", Type: "movie", CatalogID: "c", CollectionID: "c1"},
	} {
		if err := s.SetHomeLayout(id, HomeLayout{Rows: []HomeRow{bad}}); !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%+v: err = %v", bad, err)
		}
	}
	twice := HomeRow{CollectionID: "c1", Enabled: true}
	if err := s.SetHomeLayout(id, HomeLayout{Rows: []HomeRow{twice, twice}}); !errors.Is(err, ErrInvalidItem) {
		t.Errorf("a row twice: err = %v", err)
	}

	// A local-only profile keeps its layout and queues nothing.
	guest := must[Profile](t)(s.SwitchToGuest())
	check(t, s.SetHomeLayout(guest.ID, HomeLayout{Rows: []HomeRow{twice}}))
	equal(t, must[[]Push](t)(s.Pending(guest.ID)), []Push{})
	if got := must[*HomeLayout](t)(s.HomeLayout(guest.ID)); got == nil || len(got.Rows) != 1 {
		t.Fatalf("guest layout = %+v", got)
	}
}

func TestCollectionsFromNuvio(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	equal(t, must[[]Collection](t)(s.Collections(linked.ID)), []Collection{})
	must[int](t)(s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceCollections, Op: OpUpsert, Item: json.RawMessage(nuvioCollectionsJSON)}}))

	equal(t, must[[]Collection](t)(s.Collections(linked.ID)), []Collection{{
		ID: "c1", Title: "Streaming", Backdrop: "https://img.example/c1.jpg",
		Folders: []CollectionFolder{
			{ID: "f1", Title: "Netflix", HideTitle: true, Shape: "LANDSCAPE", Cover: "https://img.example/netflix.jpg",
				Sources: []CollectionSource{
					{AddonID: "community.streaming", Type: "movie", CatalogID: "nfx"},
					{AddonID: "community.streaming", Type: "series", CatalogID: "nfx", Genre: "Drama"},
				}},
			{ID: "f2", Title: "Older", Shape: "POSTER",
				Sources: []CollectionSource{{AddonID: "org.cinemeta", Type: "movie", CatalogID: "top"}}},
		},
	}})

	if got := must[[]Collection](t)(s.VisibleCollections(linked.ID)); len(got) != 1 {
		t.Fatalf("visible = %+v", got)
	}
	// A kids profile sees none: its allow-list can't name these addons yet.
	kid := kidsProfile(t, s)
	must[int](t)(s.ApplyChanges(kid.ID, []Change{{Surface: SurfaceCollections, Op: OpUpsert, Item: json.RawMessage(nuvioCollectionsJSON)}}))
	equal(t, must[[]Collection](t)(s.VisibleCollections(kid.ID)), []Collection{})

	if _, err := s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceCollections, Op: OpUpsert, Item: json.RawMessage(`{}`)}}); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("an object as collections: err = %v", err)
	}
}

func TestSetCollections(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	check(t, s.SetCollections(linked.ID, json.RawMessage(nuvioCollectionsJSON)))
	pending := must[[]Push](t)(s.Pending(linked.ID))
	if len(pending) != 1 || pending[0].Surface != SurfaceCollections {
		t.Fatalf("pending = %+v", pending)
	}
	var pushed []map[string]any
	check(t, json.Unmarshal(pending[0].Item, &pushed))
	if pushed[0]["viewMode"] != "FOLLOW_LAYOUT" {
		t.Fatalf("pushed %s", pending[0].Item)
	}
	// A pull of the same blob while the push is queued changes nothing.
	if n := must[int](t)(s.ApplyChanges(linked.ID, []Change{{Surface: SurfaceCollections, Op: OpUpsert, Item: json.RawMessage(`[]`)}})); n != 0 {
		t.Fatalf("a pull over a queued push applied %d", n)
	}
	for _, bad := range []string{`{}`, `[{"title":"No id"}]`, `[{"id":"a"},{"id":"a"}]`} {
		if err := s.SetCollections(linked.ID, json.RawMessage(bad)); !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}
