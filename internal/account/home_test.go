package account

import (
	"errors"
	"testing"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

// On Nuvio's server the layout is Nuvio's apps' and can't change here; the
// Guest keeps its own; on a custom server an edit is queued for push (#35).
func TestSetHomeLayout(t *testing.T) {
	f := newFixture(t)
	db := store.Opened(f.store)
	layout := store.HomeLayout{Rows: []store.HomeRow{{AddonID: "org.cinemeta", Type: "movie", CatalogID: "top", Enabled: true}}}

	guest, _ := f.store.CurrentProfile()
	if err := f.service.SetHomeLayout(t.Context(), guest.ID, layout); err != nil {
		t.Fatalf("guest: %v", err)
	}

	current, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	err = f.service.SetHomeLayout(t.Context(), current.ID, layout)
	if !errors.Is(err, ErrHomeFromNuvio) || code(t, err) != CodeHomeFromNuvio {
		t.Fatalf("on Nuvio's server: err = %v", err)
	}
	if got, _ := db.HomeLayout(current.ID); got != nil {
		t.Fatalf("layout = %+v", got)
	}

	own := nuviotest.NewServer(t)
	if _, err := f.service.SetServer(t.Context(), own.URL, ""); err != nil {
		t.Fatal(err)
	}
	if current, err = f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SetHomeLayout(t.Context(), current.ID, layout); err != nil {
		t.Fatal(err)
	}
	pending, _ := db.Pending(current.ID)
	if len(pending) != 1 || pending[0].Surface != store.SurfaceHomeLayout {
		t.Fatalf("pending = %+v", pending)
	}
}
