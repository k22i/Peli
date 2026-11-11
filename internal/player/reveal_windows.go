package player

import (
	"os/exec"
	"syscall"
)

// reveal opens File Explorer with path selected. Explorer reads its own
// command line, which wants the path quoted after /select, (Go would quote
// the whole argument), and it exits 1 even when it worked, so it isn't
// waited on.
func reveal(path string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + path + `"`}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
