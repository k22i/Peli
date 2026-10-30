package torrent

import (
	"cmp"
	"container/list"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"

	g "github.com/anacrolix/generics"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/storage"
)

// cache is the engine's storage: one file per verified piece, under
// dir/<info hash>/<piece index>, with the oldest pieces deleted once they
// pass max bytes. A piece being downloaded is written to
// <index>.part and renamed when it passes its hash check.
//
// Oldest by when they were written, not read: a stream reads in order, so
// the pieces it has played are older than the ones fetched ahead of it.
// Promoting a piece on read would drop those ahead first, which is what it
// needs next. The client only asks for the pieces around what the player
// reads, so it never wants more than the cap at once; it is told of each
// piece dropped, and fetches it again if the player goes back to it.
//
// The client isn't given the cap (TorrentImpl.Capacity): with one, its
// request planner stopped asking for pieces near the cap until a peer timed
// out a minute later (anacrolix/torrent v1.61).
type cache struct {
	dir string

	mu    sync.Mutex
	max   int64
	size  int64
	lru   *list.List // of *entry, newest at the front
	index map[pieceKey]*list.Element
	// Torrents being played, whose pieces Clear keeps.
	open map[metainfo.Hash]int
	// Told of each piece dropped, with mu held: the client's idea of what it
	// has is otherwise stale until a read fails, and a peer that thinks
	// we have the whole torrent drops us.
	evicted func(pieceKey)
}

type pieceKey struct {
	hash  metainfo.Hash
	index int
}

type entry struct {
	key  pieceKey
	size int64
}

// errEvicted is a read of a piece the cache deleted after the client last
// asked: the reader checks the piece again and downloads it.
var errEvicted = errors.New("torrent: piece evicted from the cache")

// openCache opens the cache in dir, keeping what earlier runs left there
// (most recently written first) within max bytes, and deleting unfinished
// pieces.
func openCache(dir string, max int64) (*cache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &cache{
		dir:     dir,
		max:     max,
		lru:     list.New(),
		index:   map[pieceKey]*list.Element{},
		open:    map[metainfo.Hash]int{},
		evicted: func(pieceKey) {},
	}
	type found struct {
		entry
		modified int64
	}
	var pieces []found
	torrents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, t := range torrents {
		var hash metainfo.Hash
		if !t.IsDir() || hash.FromHexString(t.Name()) != nil {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(dir, t.Name()))
		for _, f := range files {
			index, err := strconv.Atoi(f.Name())
			info, statErr := f.Info()
			if err != nil || statErr != nil || !info.Mode().IsRegular() {
				// A .part left by a run that ended mid-piece.
				_ = os.Remove(filepath.Join(dir, t.Name(), f.Name()))
				continue
			}
			pieces = append(pieces, found{
				entry{pieceKey{hash, index}, info.Size()},
				info.ModTime().UnixNano(),
			})
		}
	}
	slices.SortFunc(pieces, func(a, b found) int { return cmp.Compare(b.modified, a.modified) })
	for _, p := range pieces {
		c.index[p.key] = c.lru.PushBack(&entry{p.key, p.size})
		c.size += p.size
	}
	c.mu.Lock()
	c.evict(pieceKey{})
	c.mu.Unlock()
	c.removeEmpty()
	return c, nil
}

// OpenTorrent is storage.ClientImpl's.
func (c *cache) OpenTorrent(_ context.Context, info *metainfo.Info, hash metainfo.Hash) (storage.TorrentImpl, error) {
	if err := os.MkdirAll(c.torrentDir(hash), 0o700); err != nil {
		return storage.TorrentImpl{}, err
	}
	return storage.TorrentImpl{
		PieceWithHash: func(p metainfo.Piece, _ g.Option[[]byte]) storage.PieceImpl {
			return piece{c, pieceKey{hash, p.Index()}, p.Length()}
		},
		Close: func() error { return nil },
	}, nil
}

func (c *cache) torrentDir(hash metainfo.Hash) string {
	return filepath.Join(c.dir, hash.HexString())
}

func (c *cache) path(key pieceKey) string {
	return filepath.Join(c.torrentDir(key.hash), strconv.Itoa(key.index))
}

// SetMax changes the cap, deleting pieces until the cache fits.
func (c *cache) SetMax(max int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.max = max
	c.evict(pieceKey{})
}

// Size is the bytes of verified pieces kept.
func (c *cache) Size() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.size
}

// Hold keeps hash's pieces from Clear while it plays; Release lets them go.
func (c *cache) Hold(hash metainfo.Hash) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.open[hash]++
}

func (c *cache) Release(hash metainfo.Hash) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.open[hash]--; c.open[hash] <= 0 {
		delete(c.open, hash)
	}
}

// Clear deletes every piece but those of torrents being played.
func (c *cache) Clear() {
	c.mu.Lock()
	for e := c.lru.Front(); e != nil; {
		next := e.Next()
		if en := e.Value.(*entry); c.open[en.key.hash] == 0 {
			c.drop(e)
		}
		e = next
	}
	c.mu.Unlock()
	c.removeEmpty()
}

// evict deletes the oldest pieces until the cache fits, never keep. Called with mu held.
func (c *cache) evict(keep pieceKey) {
	for e := c.lru.Back(); e != nil && c.size > c.max; {
		prev := e.Prev()
		if e.Value.(*entry).key != keep {
			c.drop(e)
		}
		e = prev
	}
}

// drop deletes a piece. Called with mu held.
func (c *cache) drop(e *list.Element) {
	en := e.Value.(*entry)
	_ = os.Remove(c.path(en.key))
	c.lru.Remove(e)
	delete(c.index, en.key)
	c.size -= en.size
	c.evicted(en.key)
}

// removeEmpty deletes the folders of torrents with no pieces left.
func (c *cache) removeEmpty() {
	torrents, _ := os.ReadDir(c.dir)
	for _, t := range torrents {
		var hash metainfo.Hash
		if t.IsDir() && hash.FromHexString(t.Name()) == nil {
			c.mu.Lock()
			held := c.open[hash] > 0
			c.mu.Unlock()
			if !held {
				// Fails, as it should, unless the folder is empty.
				_ = os.Remove(filepath.Join(c.dir, t.Name()))
			}
		}
	}
}

// piece is storage.PieceImpl's, for one piece of one torrent.
type piece struct {
	c      *cache
	key    pieceKey
	length int64
}

func (p piece) final() string { return p.c.path(p.key) }
func (p piece) part() string  { return p.final() + ".part" }

// complete reports whether the cache has the verified piece.
func (p piece) complete() bool {
	p.c.mu.Lock()
	defer p.c.mu.Unlock()
	_, ok := p.c.index[p.key]
	return ok
}

func (p piece) ReadAt(b []byte, off int64) (int, error) {
	name := p.part()
	if p.complete() {
		name = p.final()
	}
	f, err := os.Open(name)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, errEvicted
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n, err := f.ReadAt(b, off)
	// A piece read up to its end is all there.
	if err == io.EOF && off+int64(n) == p.length {
		err = nil
	}
	return n, err
}

func (p piece) WriteAt(b []byte, off int64) (int, error) {
	f, err := os.OpenFile(p.part(), os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := f.WriteAt(b, off)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return n, err
}

func (p piece) MarkComplete() error {
	if err := os.Rename(p.part(), p.final()); err != nil {
		// Already complete: the client marks a piece again after checking it.
		if p.complete() {
			return nil
		}
		return err
	}
	c := p.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.index[p.key]; ok {
		c.drop(e)
	}
	c.index[p.key] = c.lru.PushFront(&entry{p.key, p.length})
	c.size += p.length
	c.evict(p.key)
	return nil
}

func (p piece) MarkNotComplete() error {
	c := p.c
	c.mu.Lock()
	if e, ok := c.index[p.key]; ok {
		c.drop(e)
	}
	c.mu.Unlock()
	return nil
}

func (p piece) Completion() storage.Completion {
	c := p.c
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.index[p.key]
	if ok && e.Value.(*entry).size != p.length {
		// Left by a run that saw the torrent with other pieces: not this one.
		c.drop(e)
		ok = false
	}
	return storage.Completion{Ok: true, Complete: ok}
}
