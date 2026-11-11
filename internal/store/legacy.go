package store

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
)

// MoveFromSinag moves an install from when the app was called Sinag to Peli's
// folders: Sinag/sinag.db in the app-data folder becomes Peli/peli.db (with
// everything else in that folder), and the Sinag cache folder becomes Peli's.
// Call it before anything opens those folders. It does nothing with
// $PELI_DATA_DIR set, and leaves a folder alone when Peli's already exists.
func MoveFromSinag() error {
	if os.Getenv("PELI_DATA_DIR") != "" {
		return nil
	}
	return moveFromSinag(xdg.DataHome, xdg.CacheHome)
}

func moveFromSinag(dataHome, cacheHome string) error {
	moved, err := moveDir(filepath.Join(dataHome, "Sinag"), filepath.Join(dataHome, "Peli"))
	if moved && err == nil {
		dir := filepath.Join(dataHome, "Peli")
		err = os.Rename(filepath.Join(dir, "sinag.db"), filepath.Join(dir, "peli.db"))
		if errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
	}
	_, cacheErr := moveDir(filepath.Join(cacheHome, "Sinag"), filepath.Join(cacheHome, "Peli"))
	return errors.Join(err, cacheErr)
}

// moveDir renames from to to when from exists and to doesn't, and reports
// whether it did.
func moveDir(from, to string) (bool, error) {
	if _, err := os.Stat(to); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if _, err := os.Stat(from); err != nil {
		return false, nil
	}
	if err := os.Rename(from, to); err != nil {
		return false, err
	}
	return true, nil
}
