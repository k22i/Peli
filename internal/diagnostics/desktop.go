//go:build !ios

package diagnostics

import (
	"os/exec"
	"runtime"
)

// Desktop is the desktop twin of the iOS platform: sharing reveals the
// folder in the file manager.
type Desktop struct{}

func (Desktop) Share(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", paths[0])
	case "windows":
		cmd = exec.Command("explorer", paths[0])
	default:
		cmd = exec.Command("xdg-open", paths[0])
	}
	return cmd.Start()
}

func (Desktop) Memory() (uint64, uint64, bool) { return 0, 0, false }

func (Desktop) Device() string { return runtime.GOOS + "/" + runtime.GOARCH }
