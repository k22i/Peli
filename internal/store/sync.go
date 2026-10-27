package store

import (
	"encoding/binary"
	"encoding/json"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Surface is a kind of synced data, with its own cursor and pushes.
type Surface string

const (
	SurfaceLibrary  Surface = "library"
	SurfaceProgress Surface = "progress"
	SurfaceWatched  Surface = "watched"
	SurfaceAddons   Surface = "addons"
)

// Op is what a push does to the item at its key.
type Op string

const (
	OpUpsert Op = "upsert"
	OpDelete Op = "delete"
)

// Push is a local change waiting to be sent to Nuvio (the outbox). There is at
// most one per surface and key: a newer change to the same item replaces it.
type Push struct {
	Surface Surface `json:"surface"`
	Op      Op      `json:"op"`
	Key     string  `json:"key"`
	// The item as it should be on the server, or as it was before a delete.
	Item json.RawMessage `json:"item"`
	// For an addons push, the list it was edited from: what the backend had
	// before the first edit that hasn't been sent, so the push can be merged
	// with what other devices changed since (ADR-0019). Nil for any other
	// push, and for an addons push queued before #32.
	Base json.RawMessage `json:"base,omitempty"`
	// Order of the latest change; Pending returns pushes in this order.
	Seq       uint64 `json:"seq"`
	QueuedAt  int64  `json:"queuedAt"` // ms since epoch
	Attempts  int    `json:"attempts"`
	LastError string `json:"lastError,omitempty"`
}

// Cursor returns profile id's delta cursor for surface: an opaque Nuvio event
// ID, or ok false if the surface has never been pulled.
func (s *Store) Cursor(id uint64, surface Surface) (cursor int64, ok bool, err error) {
	err = s.view(id, func(p *bolt.Bucket) error {
		if v := p.Bucket(bucketCursors).Get([]byte(surface)); v != nil {
			cursor, ok = int64(binary.BigEndian.Uint64(v)), true
		}
		return nil
	})
	return cursor, ok, err
}

// SetCursor stores profile id's delta cursor for surface.
func (s *Store) SetCursor(id uint64, surface Surface, cursor int64) error {
	return s.update(id, func(p *bolt.Bucket) error {
		return p.Bucket(bucketCursors).Put([]byte(surface), u64(uint64(cursor)))
	})
}

// Pending returns profile id's queued pushes, oldest change first.
func (s *Store) Pending(id uint64) ([]Push, error) {
	pushes := []Push{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return each(p.Bucket(bucketOutbox), func(push Push) { pushes = append(pushes, push) })
	})
	sort.Slice(pushes, func(i, j int) bool { return pushes[i].Seq < pushes[j].Seq })
	return pushes, err
}

// AckPush removes push from the outbox once the server has it. A change made
// to the same item since push was read stays queued.
func (s *Store) AckPush(id uint64, push Push) error {
	return s.updatePush(id, push, func(outbox *bolt.Bucket, key []byte, _ Push) error {
		return outbox.Delete(key)
	})
}

// FailPush records a failed attempt to send push, keeping it queued.
func (s *Store) FailPush(id uint64, push Push, cause error) error {
	return s.updatePush(id, push, func(outbox *bolt.Bucket, key []byte, queued Push) error {
		queued.Attempts++
		queued.LastError = cause.Error()
		return put(outbox, key, queued)
	})
}

// updatePush runs fn on the queued copy of push if it hasn't changed since.
func (s *Store) updatePush(id uint64, push Push, fn func(outbox *bolt.Bucket, key []byte, queued Push) error) error {
	return s.update(id, func(p *bolt.Bucket) error {
		outbox := p.Bucket(bucketOutbox)
		key := joinKey(string(push.Surface), push.Key)
		data := outbox.Get(key)
		if data == nil {
			return nil
		}
		var queued Push
		if err := json.Unmarshal(data, &queued); err != nil {
			return err
		}
		if queued.Seq != push.Seq {
			return nil
		}
		return fn(outbox, key, queued)
	})
}

// remove deletes key from profile bucket p's bucket and queues the delete
// under pushKey, carrying the item as it was. Removing a missing item does
// nothing.
func remove(p *bolt.Bucket, bucket []byte, surface Surface, key []byte, pushKey string) error {
	b := p.Bucket(bucket)
	item := b.Get(key)
	if item == nil {
		return nil
	}
	if err := enqueue(p, surface, OpDelete, pushKey, json.RawMessage(item)); err != nil {
		return err
	}
	return b.Delete(key)
}

// enqueue queues a push for a local change, if profile bucket p syncs. It runs
// in the change's transaction, so the change and its push commit together.
func enqueue(p *bolt.Bucket, surface Surface, op Op, key string, item any) error {
	data, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return queue(p, Push{Surface: surface, Op: op, Key: key, Item: data})
}

// queue is enqueue for a push that is already built.
func queue(p *bolt.Bucket, push Push) error {
	if ok, err := syncs(p); err != nil || !ok {
		return err
	}
	push.QueuedAt = time.Now().UnixMilli()
	outbox := p.Bucket(bucketOutbox)
	seq, err := outbox.NextSequence()
	if err != nil {
		return err
	}
	push.Seq = seq
	return put(outbox, joinKey(string(push.Surface), push.Key), push)
}
