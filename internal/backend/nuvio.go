package backend

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
)

// ErrNotLinked means the profile has no Nuvio profile to sync with.
var ErrNotLinked = errors.New("backend: profile isn't linked to a Nuvio profile")

// pushBatch is the most rows one push RPC carries.
const pushBatch = 500

// Sessions hands out a session that works: account.Session in the app. Do
// calls fn with a fresh session and, if the backend says it's signed out,
// refreshes once and calls it again, so fn must be safe to repeat.
type Sessions interface {
	Do(ctx context.Context, fn func(nuvio.Session) error) error
}

// Nuvio syncs a linked profile with its Nuvio profile, over the RPCs of
// internal/nuvio. It keeps no state: cursors and the outbox are the store's.
type Nuvio struct {
	Client   *nuvio.Client
	Sessions Sessions
}

func indexOf(profile store.Profile) (int, error) {
	if profile.NuvioIndex == nil {
		return 0, ErrNotLinked
	}
	return *profile.NuvioIndex, nil
}

// Pull reads the surface's delta feed from cursor, page after page until a
// short one. Addons have no feed: Pull returns the whole list, as one change,
// every time, and the cursor stays as it was.
func (n Nuvio) Pull(ctx context.Context, profile store.Profile, surface store.Surface, cursor int64, ok bool) ([]Change, int64, error) {
	index, err := indexOf(profile)
	if err != nil {
		return nil, cursor, err
	}
	if !ok {
		cursor = 0
	}
	var changes []Change
	next := cursor
	err = n.Sessions.Do(ctx, func(s nuvio.Session) error {
		changes, next = nil, cursor
		if surface == store.SurfaceAddons {
			change, err := n.pullAddons(ctx, s, index)
			changes = []Change{change}
			return err
		}
		for {
			page, last, err := n.page(ctx, s, index, surface, next)
			if err != nil {
				return err
			}
			changes = append(changes, page...)
			if len(page) > 0 {
				next = last
			}
			if len(page) < nuvio.DeltaLimit {
				return nil
			}
		}
	})
	if err != nil {
		return nil, cursor, err
	}
	return changes, next, nil
}

// page reads one page of a feed, and returns it as changes with the ID of its
// last event.
func (n Nuvio) page(ctx context.Context, s nuvio.Session, index int, surface store.Surface, since int64) (changes []Change, last int64, err error) {
	add := func(eventID int64, op nuvio.Operation, item any) error {
		change, err := newChange(surface, store.Op(op), item)
		if err != nil {
			return err
		}
		changes, last = append(changes, change), eventID
		return nil
	}
	switch surface {
	case store.SurfaceLibrary:
		events, err := n.Client.LibraryDelta(ctx, s, index, since)
		if err != nil {
			return nil, 0, err
		}
		for _, e := range events {
			if err := add(e.EventID, e.Operation, libraryItem(e.LibraryRow)); err != nil {
				return nil, 0, err
			}
		}
		return changes, last, nil
	case store.SurfaceProgress:
		events, err := n.Client.ProgressDelta(ctx, s, index, since)
		if err != nil {
			return nil, 0, err
		}
		for _, e := range events {
			if err := add(e.EventID, e.Operation, progress(e.ProgressRow)); err != nil {
				return nil, 0, err
			}
		}
		return changes, last, nil
	case store.SurfaceWatched:
		events, err := n.Client.WatchedDelta(ctx, s, index, since)
		if err != nil {
			return nil, 0, err
		}
		for _, e := range events {
			if err := add(e.EventID, e.Operation, watchedItem(e.WatchedRow)); err != nil {
				return nil, 0, err
			}
		}
		return changes, last, nil
	}
	return nil, 0, fmt.Errorf("backend: no delta feed for %q", surface)
}

func (n Nuvio) pullAddons(ctx context.Context, s nuvio.Session, index int) (Change, error) {
	rows, err := n.Client.Addons(ctx, s, index)
	if err != nil {
		return Change{}, err
	}
	addons := make([]store.Addon, len(rows))
	for i, r := range rows {
		addons[i] = store.Addon{URL: r.URL, Name: r.Name, Enabled: r.Enabled}
	}
	return newChange(store.SurfaceAddons, store.OpUpsert, addons)
}

// newChange wraps item, which store.PushKey names.
func newChange(surface store.Surface, op store.Op, item any) (Change, error) {
	data, err := json.Marshal(item)
	if err != nil {
		return Change{}, err
	}
	key, err := store.PushKey(surface, data)
	if err != nil {
		return Change{}, err
	}
	return Change{Surface: surface, Op: op, Key: key, Item: data}, nil
}

func libraryItem(r nuvio.LibraryRow) store.LibraryItem {
	return store.LibraryItem(r)
}

func libraryRow(i store.LibraryItem) nuvio.LibraryRow {
	return nuvio.LibraryRow(i)
}

func progress(r nuvio.ProgressRow) store.Progress {
	key := r.ProgressKey
	if key == "" {
		key = store.ProgressKey(r.ContentID, r.Season, r.Episode)
	}
	return store.Progress{
		Key: key, ContentID: r.ContentID, ContentType: r.ContentType, VideoID: r.VideoID,
		Season: r.Season, Episode: r.Episode, Position: r.Position, Duration: r.Duration, LastWatched: r.LastWatched,
	}
}

func progressRow(p store.Progress) nuvio.ProgressRow {
	// The server builds the progress key from the rest.
	return nuvio.ProgressRow{
		ContentID: p.ContentID, ContentType: p.ContentType, VideoID: p.VideoID, Season: p.Season,
		Episode: p.Episode, Position: p.Position, Duration: p.Duration, LastWatched: p.LastWatched,
	}
}

func watchedItem(r nuvio.WatchedRow) store.WatchedItem {
	return store.WatchedItem(r)
}

func watchedRow(i store.WatchedItem) nuvio.WatchedRow {
	return nuvio.WatchedRow(i)
}

// batch is the pushes of one surface and operation that go in one RPC.
type batch struct {
	surface store.Surface
	op      store.Op
	pushes  []store.Push
}

// Push sends the pushes in a few calls per surface: one for the upserts and
// one for the deletes, in pages of pushBatch. The outbox holds at most one
// push per item, so the order of the calls doesn't matter.
//
// Progress is acked once it is sent, though the server drops an entry that
// hasn't moved 15 s or isn't 30 s newer than its own: the next push carries
// newer data, and a dropped one means the server is almost as far along.
// Addons replace the whole list, so only the newest addons push is sent, and
// it is always the whole list; all of them are acked with it.
func (n Nuvio) Push(ctx context.Context, profile store.Profile, pushes []store.Push) ([]store.Push, error) {
	index, err := indexOf(profile)
	if err != nil {
		return nil, err
	}
	var acked []store.Push
	var failed []error
	for _, b := range batches(pushes) {
		err := n.Sessions.Do(ctx, func(s nuvio.Session) error { return n.send(ctx, s, index, b) })
		if err == nil {
			acked = append(acked, b.pushes...)
			continue
		}
		failed = append(failed, err)
		if Down(err) || ctx.Err() != nil {
			break
		}
	}
	return acked, errors.Join(failed...)
}

// Down is whether err is about the backend or the session as a whole (signed
// out, unreachable, rate limited, down), not about the batch or feed that met
// it.
func Down(err error) bool {
	for _, target := range []error{nuvio.ErrSignedOut, nuvio.ErrUnreachable, nuvio.ErrRateLimited, nuvio.ErrUnavailable} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

// Offline is whether err is the user being offline or signed out, which is
// expected and not worth a log line: the account service already tells them
// when the session has ended.
func Offline(err error) bool {
	return errors.Is(err, nuvio.ErrSignedOut) || errors.Is(err, nuvio.ErrUnreachable)
}

// batches groups pushes, which are in the order they were made, into RPCs.
// One of a kind Nuvio has no call for gets a batch too, which send fails, so
// the failure is recorded on the push rather than silent.
func batches(pushes []store.Push) []batch {
	type kind struct {
		surface store.Surface
		op      store.Op
	}
	var order []kind
	groups := map[kind][]store.Push{}
	for _, p := range pushes {
		k := kind{p.Surface, p.Op}
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], p)
	}
	var out []batch
	for _, k := range order {
		group := groups[k]
		if k.surface == store.SurfaceAddons {
			out = append(out, batch{k.surface, k.op, group})
			continue
		}
		for len(group) > 0 {
			page := group[:min(pushBatch, len(group))]
			group = group[len(page):]
			out = append(out, batch{k.surface, k.op, page})
		}
	}
	return out
}

// send makes the RPC for b.
func (n Nuvio) send(ctx context.Context, s nuvio.Session, index int, b batch) error {
	c, upsert := n.Client, b.op == store.OpUpsert
	if !upsert && (b.op != store.OpDelete || b.surface == store.SurfaceAddons) {
		return fmt.Errorf("backend: no call to push %s %s", b.surface, b.op)
	}
	switch b.surface {
	case store.SurfaceLibrary:
		if upsert {
			rows, err := decode(b.pushes, libraryRow)
			if err != nil {
				return err
			}
			return c.PushLibrary(ctx, s, index, rows)
		}
		keys, err := decode(b.pushes, func(i store.LibraryItem) nuvio.LibraryKey {
			return nuvio.LibraryKey{ContentID: i.ContentID, ContentType: i.ContentType}
		})
		if err != nil {
			return err
		}
		return c.DeleteLibrary(ctx, s, index, keys)
	case store.SurfaceProgress:
		if upsert {
			rows, err := decode(b.pushes, progressRow)
			if err != nil {
				return err
			}
			return c.PushProgress(ctx, s, index, rows)
		}
		keys, err := decode(b.pushes, func(p store.Progress) string {
			return cmp.Or(p.Key, store.ProgressKey(p.ContentID, p.Season, p.Episode))
		})
		if err != nil {
			return err
		}
		return c.DeleteProgress(ctx, s, index, keys)
	case store.SurfaceWatched:
		if upsert {
			rows, err := decode(b.pushes, watchedRow)
			if err != nil {
				return err
			}
			return c.PushWatched(ctx, s, index, rows)
		}
		keys, err := decode(b.pushes, func(i store.WatchedItem) nuvio.WatchedKey {
			return nuvio.WatchedKey{ContentID: i.ContentID, Season: i.Season, Episode: i.Episode}
		})
		if err != nil {
			return err
		}
		return c.DeleteWatched(ctx, s, index, keys)
	case store.SurfaceAddons:
		var list []store.Addon
		newest := b.pushes[len(b.pushes)-1]
		if err := json.Unmarshal(newest.Item, &list); err != nil {
			return fmt.Errorf("backend: addons push: %w", err)
		}
		rows := make([]nuvio.AddonRow, len(list))
		for i, a := range list {
			rows[i] = nuvio.AddonRow{URL: a.URL, Name: a.Name, Enabled: a.Enabled}
		}
		return c.PushAddons(ctx, s, index, rows)
	}
	return fmt.Errorf("backend: no call to push %s", b.surface)
}

// decode reads each push's item as T and converts it.
func decode[T, R any](pushes []store.Push, convert func(T) R) ([]R, error) {
	rows := make([]R, len(pushes))
	for i, p := range pushes {
		var item T
		if err := json.Unmarshal(p.Item, &item); err != nil {
			return nil, fmt.Errorf("backend: %s push %q: %w", p.Surface, p.Key, err)
		}
		rows[i] = convert(item)
	}
	return rows, nil
}
