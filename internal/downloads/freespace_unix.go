//go:build !windows

package downloads

import (
	"errors"
	"syscall"

	"golang.org/x/sys/unix"
)

// freeSpace is what is available to this app on dir's volume.
func freeSpace(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// diskFull reports a write that failed for want of space.
func diskFull(err error) bool { return errors.Is(err, syscall.ENOSPC) }
