//go:build !windows

package player

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

// reveal shows path selected in Finder, or opens its folder on Linux,
// whose file managers have no common way to select a file.
func reveal(path string) error {
	cmd := exec.Command("xdg-open", filepath.Dir(path))
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("open", "-R", path)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
