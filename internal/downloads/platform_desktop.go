//go:build !ios

package downloads

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// desktopPlatform is the Mac, Windows and Linux Platform: always online and
// never metered (offline shows up as network errors), no background to ask
// for, and a folder dialog.
type desktopPlatform struct{}

func newPlatform() Platform { return desktopPlatform{} }

func (desktopPlatform) FreeSpace(dir string) (int64, error) { return freeSpace(dir) }

func (desktopPlatform) Prepare(root string) error { return os.MkdirAll(root, 0o700) }

func (desktopPlatform) Network() Network { return Network{Online: true} }

func (desktopPlatform) WatchNetwork(func(Network)) {}

func (desktopPlatform) Background(func()) func() { return func() {} }

func (desktopPlatform) WatchLifecycle(background, active func()) {}

// ChooseFolder shows the folder dialog and checks the folder can be written
// to; "" when cancelled.
func (desktopPlatform) ChooseFolder() (string, error) {
	app := application.Get()
	if app == nil {
		return "", errors.New("downloads: the app isn't running")
	}
	dir, err := app.Dialog.OpenFile().
		SetTitle("Choose a folder for downloads").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil || dir == "" {
		// Wails reports a cancelled dialog as an empty path.
		return "", nil
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	probe, err := os.CreateTemp(dir, ".peli-write-*")
	if err != nil {
		return "", errors.New("downloads: that folder can't be written to")
	}
	probe.Close()
	_ = os.Remove(probe.Name())
	return dir, nil
}
