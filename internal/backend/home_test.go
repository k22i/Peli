package backend

import (
	"testing"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/store"
)

// The home layout and collections are pulled from Nuvio's server like any
// other surface: the whole blob, or a delete when there is none (#35).
func TestPullHome(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	for _, surface := range []store.Surface{store.SurfaceHomeLayout, store.SurfaceCollections} {
		changes, next, err := d.backend.Pull(t.Context(), d.profile, surface, 7, true)
		check(t, err)
		if len(changes) != 1 || changes[0].Op != store.OpDelete || next != 7 {
			t.Fatalf("%s with none: %+v, cursor %d", surface, changes, next)
		}
	}

	server.SetHomeLayout(t, email, 1, "home_catalog_shared", `{"items":[{"key":"collection_c1","is_collection":true,"collection_id":"c1","enabled":true,"order":0}],"hide_unreleased_content":false}`)
	server.SetCollections(t, email, 1, `[{"id":"c1","title":"Anime","folders":[]}]`)
	for _, surface := range []store.Surface{store.SurfaceHomeLayout, store.SurfaceCollections} {
		changes, _, err := d.backend.Pull(t.Context(), d.profile, surface, 0, true)
		check(t, err)
		if len(changes) != 1 || changes[0].Op != store.OpUpsert {
			t.Fatalf("%s: %+v", surface, changes)
		}
		_, err = d.store.ApplyChanges(d.profile.ID, changes)
		check(t, err)
	}
	layout, err := d.store.HomeLayout(d.profile.ID)
	check(t, err)
	collections, err := d.store.Collections(d.profile.ID)
	check(t, err)
	if layout == nil || len(layout.Rows) != 1 || layout.Rows[0].CollectionID != "c1" || len(collections) != 1 || collections[0].Title != "Anime" {
		t.Fatalf("layout %+v, collections %+v", layout, collections)
	}
}

// On Nuvio's server a layout push is acked without a request.
func TestPushHomeDroppedOnNuviosServer(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	check(t, d.store.SetHomeLayout(d.profile.ID, store.HomeLayout{Rows: []store.HomeRow{{CollectionID: "c1", Enabled: true}}}))
	pending, err := d.store.Pending(d.profile.ID)
	check(t, err)
	calls := len(server.Calls())
	acked, err := d.backend.Push(t.Context(), d.profile, pending)
	if err != nil || len(acked) != 1 || acked[0].Surface != store.SurfaceHomeLayout {
		t.Fatalf("acked %+v, %v", acked, err)
	}
	if got := server.Calls()[calls:]; len(got) != 0 {
		t.Fatalf("the dropped push made requests: %v", got)
	}
}
