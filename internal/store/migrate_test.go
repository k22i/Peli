package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

var update = flag.Bool("update", false, "rewrite testdata/schema-*.db")

// fixtureData is written to each testdata/schema-<n>.db when it is created.
func fixtureData(t *testing.T, s *Store) {
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Fixture", NuvioIndex: ptr(1)}))
	check(t, s.SaveLibraryItem(p.ID, dune))
	must[Progress](t)(s.SaveProgress(p.ID, episode))
	check(t, s.MarkWatched(p.ID, WatchedItem{ContentID: "tt1160419", ContentType: "movie", WatchedAt: 4000}))
	check(t, s.SetAddons(p.ID, []Addon{cinemeta}))
	check(t, s.SetCursor(p.ID, SurfaceLibrary, 242_369_012))
	check(t, s.SaveProfileSettings(p.ID, japanese))
	check(t, s.SaveDeviceSettings(DeviceSettings{Diagnostics: true, TorrentCacheGB: 5}))
}

// Every shipped schema has a fixture written by the build that introduced it.
// The current build must open each one, migrate it and read its data.
// Regenerate the newest with: go test ./internal/store -run TestFixtures -update
func TestFixtures(t *testing.T) {
	newest := filepath.Join("testdata", "schema-"+strconv.Itoa(len(migrations))+".db")
	if *update {
		if err := os.Remove(newest); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		s, err := Open(newest)
		check(t, err)
		fixtureData(t, s)
		check(t, s.Close())
	}

	paths, err := filepath.Glob(filepath.Join("testdata", "schema-*.db"))
	check(t, err)
	if !slices.Contains(paths, newest) {
		t.Fatalf("no fixture for schema %d: run go test ./internal/store -run TestFixtures -update", len(migrations))
	}
	for _, fixture := range paths {
		t.Run(filepath.Base(fixture), func(t *testing.T) {
			data, err := os.ReadFile(fixture)
			check(t, err)
			path := filepath.Join(t.TempDir(), "sinag.db")
			check(t, os.WriteFile(path, data, 0o600))

			s, err := Open(path)
			check(t, err)
			defer s.Close()

			profiles := must[[]Profile](t)(s.Profiles())
			if len(profiles) != 1 || profiles[0].Name != "Fixture" {
				t.Fatalf("profiles = %+v", profiles)
			}
			id := profiles[0].ID
			equal(t, must[[]LibraryItem](t)(s.Library(id)), []LibraryItem{dune})
			progress := must[[]Progress](t)(s.ContinueWatching(id))
			if len(progress) != 1 || progress[0].Key != "tt11280740_s1e2" || progress[0].Position != episode.Position {
				t.Fatalf("progress = %+v", progress)
			}
			equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{cinemeta})
			if cursor, _, _ := s.Cursor(id, SurfaceLibrary); cursor != 242_369_012 {
				t.Fatalf("cursor = %d", cursor)
			}
			if pending := must[[]Push](t)(s.Pending(id)); len(pending) != 4 {
				t.Fatalf("pending = %d pushes, want 4", len(pending))
			}
			// Settings arrived in schema 2; older files read as the defaults.
			// Fields added since (#55) read as their defaults.
			profileSettings, deviceSettings := japanese, DeviceSettings{Diagnostics: true, TorrentCacheGB: 5}
			if filepath.Base(fixture) == "schema-1.db" {
				profileSettings, deviceSettings = DefaultProfileSettings(), DefaultDeviceSettings()
			}
			equal(t, must[ProfileSettings](t)(s.ProfileSettings(id)), profileSettings)
			equal(t, must[DeviceSettings](t)(s.DeviceSettings()), deviceSettings)
		})
	}
}

// Migrations run forward from an older file, keep its data and record the
// new version; a later build can rewrite records.
func TestMigrateForward(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sinag.db")
	s, err := Open(path)
	check(t, err)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	check(t, s.SaveLibraryItem(p.ID, dune))
	check(t, s.Close())

	// A future migration that upper-cases every library item's name.
	next := append(migrations[:len(migrations):len(migrations)], func(tx *bolt.Tx) error {
		return tx.Bucket(bucketProfiles).ForEachBucket(func(id []byte) error {
			library := tx.Bucket(bucketProfiles).Bucket(id).Bucket(bucketLibrary)
			return library.ForEach(func(k, v []byte) error {
				var item LibraryItem
				if err := json.Unmarshal(v, &item); err != nil {
					return err
				}
				item.Name = strings.ToUpper(item.Name)
				return put(library, k, item)
			})
		})
	})
	db, err := bolt.Open(path, 0o600, nil)
	check(t, err)
	check(t, migrate(db, next))
	if v := version(t, db); v != uint64(len(next)) {
		t.Fatalf("schema = %d, want %d", v, len(next))
	}
	// Running again is a no-op.
	check(t, migrate(db, next))
	check(t, db.Close())

	// This build now refuses the newer file instead of misreading it.
	if _, err := Open(path); !errors.Is(err, ErrNewerSchema) {
		t.Fatalf("Open(newer) err = %v, want ErrNewerSchema", err)
	}

	db, err = bolt.Open(path, 0o600, nil)
	check(t, err)
	defer db.Close()
	check(t, db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bucketProfiles).Bucket(u64(p.ID)).Bucket(bucketLibrary).Get([]byte(libraryKey(dune.ContentID, dune.ContentType)))
		var item LibraryItem
		check(t, json.Unmarshal(v, &item))
		if item.Name != "DUNE" {
			t.Fatalf("migrated name = %q", item.Name)
		}
		return nil
	}))
}

// Schema 3 flags the Guest: the oldest local-only profile, which only
// CurrentProfile made before.
func TestMigrateFlagsGuest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sinag.db")
	db, err := bolt.Open(path, 0o600, nil)
	check(t, err)
	check(t, migrate(db, migrations[:2]))
	var ids []uint64
	check(t, db.Update(func(tx *bolt.Tx) error {
		for _, profile := range []Profile{{Name: "Kevin", NuvioIndex: ptr(1)}, {Name: "Guest"}, {Name: "Local"}} {
			created, err := createProfile(tx, profile)
			if err != nil {
				return err
			}
			ids = append(ids, created.ID)
		}
		return nil
	}))
	check(t, db.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	var guests []string
	for _, profile := range must[[]Profile](t)(s.Profiles()) {
		if profile.Guest {
			guests = append(guests, profile.Name)
		}
	}
	equal(t, guests, []string{"Guest"})
	equal(t, must[Profile](t)(s.CurrentProfile()).ID, ids[0])
}

// A failed migration leaves the file at the version before it.
func TestFailedMigrationRollsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sinag.db")
	db, err := bolt.Open(path, 0o600, nil)
	check(t, err)
	defer db.Close()

	broken := append(migrations[:len(migrations):len(migrations)], func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucket([]byte("half-done")); err != nil {
			return err
		}
		return errors.New("disk on fire")
	})
	if err := migrate(db, broken); err == nil || !strings.Contains(err.Error(), "disk on fire") {
		t.Fatalf("migrate err = %v", err)
	}
	if v := version(t, db); v != uint64(len(migrations)) {
		t.Fatalf("schema = %d, want %d", v, len(migrations))
	}
	check(t, db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte("half-done")) != nil {
			t.Fatal("failed migration's changes were kept")
		}
		return nil
	}))
}

func version(t *testing.T, db *bolt.DB) (v uint64) {
	t.Helper()
	check(t, db.View(func(tx *bolt.Tx) error {
		v = binary.BigEndian.Uint64(tx.Bucket(bucketMeta).Get(keySchema))
		return nil
	}))
	return v
}
