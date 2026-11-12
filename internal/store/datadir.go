//go:build !ios

package store

import (
	"path/filepath"

	"github.com/adrg/xdg"
)

// dataDir is Peli's folder in the OS app-data directory.
func dataDir() string { return filepath.Join(xdg.DataHome, "Peli") }
