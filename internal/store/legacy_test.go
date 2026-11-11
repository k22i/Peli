package store

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMoveFromSinag(t *testing.T) {
	data, cache := t.TempDir(), t.TempDir()
	write(t, filepath.Join(data, "Sinag", "sinag.db"), "db")
	write(t, filepath.Join(data, "Sinag", "anime-list.json"), "list")
	write(t, filepath.Join(cache, "Sinag", "torrents", "piece"), "piece")

	if err := moveFromSinag(data, cache); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(data, "Peli", "peli.db")); got != "db" {
		t.Errorf("peli.db = %q", got)
	}
	if got := read(t, filepath.Join(data, "Peli", "anime-list.json")); got != "list" {
		t.Errorf("other files: %q", got)
	}
	if got := read(t, filepath.Join(cache, "Peli", "torrents", "piece")); got != "piece" {
		t.Errorf("cache: %q", got)
	}
	if _, err := os.Stat(filepath.Join(data, "Sinag")); !os.IsNotExist(err) {
		t.Errorf("Sinag data folder still there: %v", err)
	}

	// Run again (every start does): nothing to move, nothing changes.
	if err := moveFromSinag(data, cache); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(data, "Peli", "peli.db")); got != "db" {
		t.Errorf("second run: peli.db = %q", got)
	}
}

func TestMoveFromSinagKeepsPelisFolder(t *testing.T) {
	data, cache := t.TempDir(), t.TempDir()
	write(t, filepath.Join(data, "Sinag", "sinag.db"), "old")
	write(t, filepath.Join(data, "Peli", "peli.db"), "new")

	if err := moveFromSinag(data, cache); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(data, "Peli", "peli.db")); got != "new" {
		t.Errorf("peli.db = %q, want Peli's own kept", got)
	}
	if got := read(t, filepath.Join(data, "Sinag", "sinag.db")); got != "old" {
		t.Errorf("Sinag's folder touched: %q", got)
	}
}

func TestMoveFromSinagWithNothingToMove(t *testing.T) {
	data, cache := t.TempDir(), t.TempDir()
	if err := moveFromSinag(data, cache); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(data, "Peli")); !os.IsNotExist(err) {
		t.Errorf("made a Peli folder from nothing: %v", err)
	}
}
