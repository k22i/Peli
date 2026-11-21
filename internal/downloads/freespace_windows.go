//go:build windows

package downloads

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// freeSpace is what is available to this app on dir's volume.
func freeSpace(dir string) (int64, error) {
	path, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(path, &free, &total, &totalFree); err != nil {
		return 0, err
	}
	return int64(free), nil
}

// diskFull reports a write that failed for want of space: ERROR_HANDLE_DISK_FULL
// (39) or ERROR_DISK_FULL (112).
func diskFull(err error) bool {
	return errors.Is(err, syscall.Errno(39)) || errors.Is(err, syscall.Errno(112)) || errors.Is(err, syscall.ENOSPC)
}
