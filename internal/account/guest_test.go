package account

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
)

// A guest uses Sinag with no request to Nuvio (#23): launching, writing every
// synced surface and syncing through the profile's backend.
func TestGuestMakesNoNuvioRequests(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		t.Errorf("guest sent %s %s to Nuvio", r.Method, r.URL)
		w.WriteHeader(http.StatusTeapot)
	}))
	defer server.Close()

	db := store.NewService(filepath.Join(t.TempDir(), "sinag.db"))
	if err := db.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	defer db.ServiceShutdown()
	service := NewService(nuvio.New(server.URL, "1.2.3"), &memKeychain{items: map[string]string{}}, db)
	if err := service.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	defer service.ServiceShutdown()

	guest, err := db.SwitchToGuest()
	if err != nil {
		t.Fatal(err)
	}
	if status, err := service.Status(); err != nil || status.SignedIn || status.SessionEnded {
		t.Fatalf("Status = %+v, %v", status, err)
	}
	s := store.Opened(db)
	if err := s.SetAddons(guest.ID, []store.Addon{{URL: "https://v3-cinemeta.strem.io/manifest.json", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveLibraryItem(guest.ID, store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveProgress(guest.ID, store.Progress{ContentID: "tt1160419", ContentType: "movie", Position: 600_000, Duration: 9_360_000, LastWatched: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkWatched(guest.ID, store.WatchedItem{ContentID: "tt1160419", ContentType: "movie", WatchedAt: 2}); err != nil {
		t.Fatal(err)
	}

	sync := backend.For(guest, nil)
	for _, surface := range []store.Surface{store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched, store.SurfaceAddons} {
		if _, _, err := sync.Pull(t.Context(), guest, surface, 0, false); err != nil {
			t.Fatal(err)
		}
	}
	pending, err := s.Pending(guest.ID)
	if err != nil || len(pending) != 0 {
		t.Fatalf("pending = %+v, %v", pending, err)
	}
	if _, err := sync.Push(t.Context(), guest, pending); err != nil {
		t.Fatal(err)
	}

	// Resuming: the progress is still here.
	if resume, err := s.ContinueWatching(guest.ID); err != nil || len(resume) != 1 || resume[0].Position != 600_000 {
		t.Fatalf("ContinueWatching = %+v, %v", resume, err)
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("%d requests to Nuvio", n)
	}
}
