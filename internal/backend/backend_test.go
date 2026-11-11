package backend

import (
	"context"
	"errors"
	"testing"

	"github.com/k22i/Peli/internal/store"
)

// linked stands in for the Nuvio backend: it fails every call.
type linked struct{}

var errCalled = errors.New("called Nuvio")

func (linked) Pull(context.Context, store.Profile, store.Surface, int64, bool) ([]Change, int64, error) {
	return nil, 0, errCalled
}

func (linked) Push(context.Context, store.Profile, []store.Push) ([]store.Push, error) {
	return nil, errCalled
}

func TestFor(t *testing.T) {
	index := 1
	if _, ok := For(store.Profile{Name: "Kevin", NuvioIndex: &index}, linked{}).(linked); !ok {
		t.Fatal("a linked profile doesn't sync with Nuvio")
	}
	if _, ok := For(store.Profile{Name: "Guest", Guest: true}, linked{}).(Local); !ok {
		t.Fatal("the Guest doesn't sync locally")
	}
}

func TestLocal(t *testing.T) {
	guest := store.Profile{ID: 1, Name: "Guest", Guest: true}
	changes, next, err := Local{}.Pull(t.Context(), guest, store.SurfaceLibrary, 42, true)
	if err != nil || len(changes) != 0 || next != 42 {
		t.Fatalf("Pull = %v, %d, %v", changes, next, err)
	}
	pushes := []store.Push{{Surface: store.SurfaceAddons, Op: store.OpUpsert, Seq: 7}}
	acked, err := Local{}.Push(t.Context(), guest, pushes)
	if err != nil || len(acked) != 1 || acked[0].Seq != 7 {
		t.Fatalf("Push = %v, %v", acked, err)
	}
}
