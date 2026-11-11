package backend

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/store"
)

// Home layout and collections sync (#35, ADR-0022). Like addons there is no
// feed: each pull reads the whole blob of each, and the cursor stays. Unlike
// addons, a push is the blob as it is here, with no merge: Nuvio's own apps
// do the same, and only a custom server is ever pushed to.
//
// The PRD forbids pushing either to Nuvio's backend. nuvio.Client refuses
// such a push itself; Push drops it before that, as acked, so a push queued
// for some other reason can't be retried forever.

// homeSurface is whether surface is the home layout or collections.
func homeSurface(surface store.Surface) bool {
	return surface == store.SurfaceHomeLayout || surface == store.SurfaceCollections
}

// pullHome reads the home layout or collections: an upsert of the whole
// blob, or a delete if the backend has none.
func (n Nuvio) pullHome(ctx context.Context, s nuvio.Session, index int, surface store.Surface) (Change, error) {
	var blob any
	var err error
	if surface == store.SurfaceHomeLayout {
		var layout map[string]json.RawMessage
		layout, err = n.Client.HomeLayout(ctx, s, index)
		if layout != nil {
			blob = layout
		}
	} else {
		var collections []map[string]any
		collections, err = n.Client.Collections(ctx, s, index)
		if collections != nil {
			blob = collections
		}
	}
	if err != nil {
		return Change{}, err
	}
	data, err := json.Marshal(blob)
	if err != nil {
		return Change{}, err
	}
	op := store.OpUpsert
	if blob == nil {
		op = store.OpDelete
	}
	return Change{Surface: surface, Op: op, Item: data}, nil
}

// OwnServer is whether pushes of the home layout and collections go out: the
// client points at a custom server, not Nuvio's.
func (n Nuvio) OwnServer() bool { return n.Client.OwnServer() }

// pushHome sends the newest of pushes, all of one home surface. Every push
// in the batch is acked with it: each is the whole blob.
func (n Nuvio) pushHome(ctx context.Context, s nuvio.Session, index int, pushes []store.Push) error {
	newest := pushes[len(pushes)-1]
	if newest.Surface == store.SurfaceHomeLayout {
		return n.Client.PushHomeLayout(ctx, s, index, newest.Item)
	}
	return n.Client.PushCollections(ctx, s, index, newest.Item)
}

// withoutHome takes the home layout and collections pushes out of pushes
// when they mustn't be sent, and returns them to be acked unsent.
func (n Nuvio) withoutHome(pushes []store.Push) (send, dropped []store.Push) {
	if n.OwnServer() {
		return pushes, nil
	}
	for _, p := range pushes {
		if homeSurface(p.Surface) {
			slog.Warn("backend: not pushing to Nuvio's server", "surface", p.Surface)
			dropped = append(dropped, p)
		} else {
			send = append(send, p)
		}
	}
	return send, dropped
}
