package torrent

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/anacrolix/torrent/metainfo"
)

// complete writes and verifies piece i of hash, of n bytes.
func complete(t *testing.T, c *cache, hash metainfo.Hash, i int, n int64) piece {
	t.Helper()
	check(t, os.MkdirAll(c.torrentDir(hash), 0o700))
	p := piece{c, pieceKey{hash, i}, n}
	if _, err := p.WriteAt(bytes.Repeat([]byte{byte(i)}, int(n)), 0); err != nil {
		t.Fatal(err)
	}
	check(t, p.MarkComplete())
	return p
}

func has(p piece) bool { return p.Completion().Complete }

var hashA, hashB = metainfo.Hash{1}, metainfo.Hash{2}

// The cache keeps within its cap by dropping the oldest pieces, even ones
// read since: a stream has played those.
func TestCacheEvictsOldest(t *testing.T) {
	c, err := openCache(t.TempDir(), 300)
	check(t, err)
	p0 := complete(t, c, hashA, 0, 100)
	p1 := complete(t, c, hashA, 1, 100)
	p2 := complete(t, c, hashB, 0, 100)
	buf := make([]byte, 100)
	if _, err := p0.ReadAt(buf, 0); err != nil || buf[0] != 0 {
		t.Fatalf("read: %v", err)
	}
	p3 := complete(t, c, hashB, 1, 100)

	if has(p0) || !has(p1) || !has(p2) || !has(p3) || c.Size() != 300 {
		t.Fatalf("kept %v %v %v %v, %d bytes", has(p0), has(p1), has(p2), has(p3), c.Size())
	}
	if _, err := p0.ReadAt(buf, 0); !errors.Is(err, errEvicted) {
		t.Errorf("reading an evicted piece: err = %v", err)
	}
	if _, err := os.Stat(c.path(p0.key)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("evicted piece's file: %v", err)
	}

	c.SetMax(100)
	if c.Size() != 100 || !has(p3) {
		t.Errorf("after shrinking: %d bytes, newest kept %v", c.Size(), has(p3))
	}
}

// A piece bigger than the whole cap is still kept until the next one.
func TestCacheKeepsThePieceJustWritten(t *testing.T) {
	c, err := openCache(t.TempDir(), 50)
	check(t, err)
	p := complete(t, c, hashA, 0, 100)
	if !has(p) {
		t.Fatal("the piece just written was evicted")
	}
}

// What a run leaves is found by the next, newest first and within the cap;
// unfinished pieces and empty folders are cleaned up.
func TestCacheReopens(t *testing.T) {
	dir := t.TempDir()
	c, err := openCache(dir, 1000)
	check(t, err)
	old := complete(t, c, hashA, 0, 100)
	newer := complete(t, c, hashB, 0, 100)
	past := time.Now().Add(-time.Hour)
	check(t, os.Chtimes(c.path(old.key), past, past))
	partial := piece{c, pieceKey{hashB, 1}, 100}
	_, err = partial.WriteAt([]byte("half"), 0)
	check(t, err)
	check(t, os.MkdirAll(filepath.Join(dir, metainfo.Hash{9}.HexString()), 0o700))

	c, err = openCache(dir, 150)
	check(t, err)
	old.c, newer.c = c, c
	if has(old) || !has(newer) || c.Size() != 100 {
		t.Fatalf("reopened: old %v, newer %v, %d bytes", has(old), has(newer), c.Size())
	}
	if _, err := os.Stat(partial.part()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("unfinished piece left: %v", err)
	}
	for _, gone := range []metainfo.Hash{hashA, {9}} {
		if _, err := os.Stat(c.torrentDir(gone)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("empty folder %s left: %v", gone.HexString(), err)
		}
	}

	// A piece of another length is another torrent's idea of it.
	if (piece{c, newer.key, 64}).Completion().Complete {
		t.Error("a piece of the wrong length counts as complete")
	}
	if c.Size() != 0 {
		t.Errorf("size = %d", c.Size())
	}
}

// Clearing keeps what plays.
func TestCacheClearKeepsHeld(t *testing.T) {
	c, err := openCache(t.TempDir(), 1000)
	check(t, err)
	a := complete(t, c, hashA, 0, 100)
	b := complete(t, c, hashB, 0, 100)
	c.Hold(hashB)
	c.Clear()
	if has(a) || !has(b) {
		t.Fatalf("after Clear: a %v, b %v", has(a), has(b))
	}
	c.Release(hashB)
	c.Clear()
	if has(b) || c.Size() != 0 {
		t.Fatalf("after Release and Clear: b %v, %d bytes", has(b), c.Size())
	}
	if _, err := os.Stat(c.torrentDir(hashB)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("cleared torrent's folder: %v", err)
	}
}

func TestCacheMarkNotComplete(t *testing.T) {
	c, err := openCache(t.TempDir(), 1000)
	check(t, err)
	p := complete(t, c, hashA, 0, 100)
	check(t, p.MarkNotComplete())
	if has(p) || c.Size() != 0 {
		t.Fatalf("still complete: %v, %d bytes", has(p), c.Size())
	}
	// Marking again after a recheck is fine.
	p = complete(t, c, hashA, 0, 100)
	check(t, p.MarkComplete())
	if c.Size() != 100 {
		t.Errorf("size = %d", c.Size())
	}
}
