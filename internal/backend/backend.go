// Package backend is where a profile's data syncs to: Nuvio for a profile
// linked to it, or nowhere for a local-only one such as the Guest (#23).
// The sync module (#28) puts every Nuvio call behind Backend and adds auth
// and profiles to it; pulling (#29) and pushing (#30) go through For.
package backend

import (
	"context"
	"encoding/json"

	"github.com/k22i/Sinag/internal/store"
)

// Change is one item from a backend's delta feed, to apply to the local
// store without queuing a push.
type Change struct {
	Surface store.Surface   `json:"surface"`
	Op      store.Op        `json:"op"`
	Key     string          `json:"key"`
	Item    json.RawMessage `json:"item"`
}

// Backend is what a profile syncs with.
type Backend interface {
	// Pull returns profile's changes to surface since cursor (ok false: never
	// pulled), and the cursor to pass next time.
	Pull(ctx context.Context, profile store.Profile, surface store.Surface, cursor int64, ok bool) (changes []Change, next int64, err error)
	// Push sends profile's queued pushes and returns the ones the backend now
	// has, for store.AckPush.
	Push(ctx context.Context, profile store.Profile, pushes []store.Push) (acked []store.Push, err error)
}

// For returns the backend profile syncs with: linked if it is linked to a
// Nuvio profile, or Local.
func For(profile store.Profile, linked Backend) Backend {
	if profile.NuvioIndex == nil {
		return Local{}
	}
	return linked
}

// Local is the backend of a local-only profile, such as the Guest. The local
// store is the only copy of its data and it never touches the network:
// there is nothing to pull, and the store queues no pushes for it.
type Local struct{}

// Pull returns no changes and keeps the cursor.
func (Local) Pull(_ context.Context, _ store.Profile, _ store.Surface, cursor int64, _ bool) ([]Change, int64, error) {
	return nil, cursor, nil
}

// Push sends nothing anywhere. It acks what it is given, so a push queued
// before a profile went local-only doesn't wait forever.
func (Local) Push(_ context.Context, _ store.Profile, pushes []store.Push) ([]store.Push, error) {
	return pushes, nil
}
