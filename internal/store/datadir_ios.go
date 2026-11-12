//go:build ios

package store

import (
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// dataDir is the app's Application Support folder, which Wails creates on
// first use (application.Mobile.StoragePath, UIKit's own answer rather than
// a guess from $HOME and XDG). The container is per app, so there is no Peli
// folder inside it. If iOS can't make the folder it falls back to the
// documents-style path under $HOME, which exists in every sandbox.
func dataDir() string {
	if dir := application.Mobile.StoragePath(); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support")
}
