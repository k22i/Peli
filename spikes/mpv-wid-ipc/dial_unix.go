//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

func ipcEndpoint() string {
	return filepath.Join(os.TempDir(), fmt.Sprintf("peli-mpv-%d.sock", os.Getpid()))
}

func dialEndpoint(path string) (net.Conn, error) { return net.Dial("unix", path) }
