// Package backend is the sync module (#28): where a profile's data syncs to.
// Every call to a Nuvio backend, and so every Supabase call, goes through
// it or through internal/nuvio, which it builds on (boundary_test.go in that
// package enforces this).
//
// Two interfaces split the work:
//   - Backend is the data a profile syncs: library, progress, watched items
//     and addons. Nuvio implements it for a profile linked to a Nuvio
//     profile, Local for one that isn't, such as the Guest (#23). For picks
//     one. Pulling (#29) and pushing (#30) go through it.
//   - Remote is the account side a linked profile needs: sign-in, sessions,
//     profiles, PINs and avatars. Only Nuvio has accounts, so only
//     *nuvio.Client implements it. A custom server (#34) speaks the same
//     protocol and is another *nuvio.Client at another URL.
package backend

import (
	"context"

	"github.com/k22i/Sinag/internal/store"
)

// Change is one item from a backend's delta feed, to apply to the local
// store without queuing a push (store.ApplyChanges).
type Change = store.Change

// Backend is what a profile syncs with.
type Backend interface {
	// Pull returns profile's changes to surface since cursor (ok false: never
	// pulled), and the cursor to pass next time. It returns every change
	// since cursor, across as many pages as that takes. Changes are
	// idempotent, so a pull that fails can be repeated from the same cursor.
	// The echo of the caller's own pushes comes back too.
	Pull(ctx context.Context, profile store.Profile, surface store.Surface, cursor int64, ok bool) (changes []Change, next int64, err error)
	// Push sends profile's queued pushes and returns the ones the backend now
	// has, for store.AckPush. Pushes that failed are left out of acked, and
	// err says why. A backend-wide failure (signed out, unreachable, rate
	// limited, down) stops the push at once; a failure of one batch doesn't
	// stop the other batches.
	Push(ctx context.Context, profile store.Profile, pushes []store.Push) (acked []store.Push, err error)
}

// Syncs is whether the sync module has a call to push surface to Nuvio.
// Home layout and collections have none, and must never be pushed to the
// official backend (#35); nothing queues them today, and Push refuses them
// should that change.
func Syncs(surface store.Surface) bool {
	switch surface {
	case store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched, store.SurfaceAddons:
		return true
	}
	return false
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
