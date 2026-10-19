package store

import (
	"fmt"
	"testing"

	bolt "go.etcd.io/bbolt"
)

// heavyProfile fills a profile like a heavy user's: 3,000 library items,
// 3,000 progress entries over 300 series and 50,000 watched episodes.
func heavyProfile(b *testing.B, s *Store) uint64 {
	p := must[Profile](b)(s.CreateProfile(Profile{Name: "Heavy"}))
	check(b, s.update(p.ID, func(pb *bolt.Bucket) error {
		for i := range 3000 {
			item := LibraryItem{
				ContentID: fmt.Sprintf("tt%07d", i), ContentType: "series", Name: fmt.Sprintf("Title %d", i),
				Poster: "https://images.metahub.space/poster/medium/tt0000000/img", Genres: []string{"Drama", "Comedy"},
				Description: "A synopsis of a couple of sentences, about as long as Cinemeta's.", AddedAt: int64(i),
			}
			if err := put(pb.Bucket(bucketLibrary), []byte(libraryKey(item.ContentID, item.ContentType)), item); err != nil {
				return err
			}
		}
		for i := range 3000 {
			entry := Progress{
				ContentID: fmt.Sprintf("tt%07d", i/10), ContentType: "series", Season: ptr(1), Episode: ptr(i % 10),
				Position: 600_000, Duration: 3_000_000, LastWatched: int64(i),
			}
			entry.Key = ProgressKey(entry.ContentID, entry.Season, entry.Episode)
			if err := put(pb.Bucket(bucketProgress), []byte(entry.Key), entry); err != nil {
				return err
			}
		}
		for i := range 50_000 {
			item := WatchedItem{
				ContentID: fmt.Sprintf("tt%07d", i/100), ContentType: "series", Title: "Title",
				Season: ptr(i / 10 % 10), Episode: ptr(i % 10), WatchedAt: int64(i),
			}
			if err := put(pb.Bucket(bucketWatched), watchedKey(item.ContentID, item.Season, item.Episode), item); err != nil {
				return err
			}
		}
		return nil
	}))
	return p.ID
}

// Home's data at launch: Continue Watching plus the library.
func BenchmarkHome(b *testing.B) {
	s, path := openTemp(b)
	id := heavyProfile(b, s)
	check(b, s.Close())

	b.Run("open+home", func(b *testing.B) {
		for b.Loop() {
			s, err := Open(path)
			check(b, err)
			must[[]Progress](b)(s.ContinueWatching(id))
			must[[]LibraryItem](b)(s.Library(id))
			check(b, s.Close())
		}
	})

	s, err := Open(path)
	check(b, err)
	defer s.Close()
	b.Run("continue-watching", func(b *testing.B) {
		for b.Loop() {
			must[[]Progress](b)(s.ContinueWatching(id))
		}
	})
	b.Run("library", func(b *testing.B) {
		for b.Loop() {
			must[[]LibraryItem](b)(s.Library(id))
		}
	})
	b.Run("title-watched", func(b *testing.B) {
		for b.Loop() {
			must[[]WatchedItem](b)(s.TitleWatched(id, "tt0000250"))
		}
	})
	b.Run("all-watched", func(b *testing.B) {
		for b.Loop() {
			must[[]WatchedItem](b)(s.Watched(id))
		}
	})
}
