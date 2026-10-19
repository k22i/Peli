//go:build windows

package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/Microsoft/go-winio"
)

func ipcEndpoint() string { return fmt.Sprintf(`\\.\pipe\sinag-mpv-%d`, os.Getpid()) }

// go-winio opens the pipe for overlapped I/O, so the read loop and command
// writes don't serialise on the handle the way os.OpenFile would.
func dialEndpoint(path string) (net.Conn, error) {
	timeout := time.Second
	return winio.DialPipe(path, &timeout)
}
