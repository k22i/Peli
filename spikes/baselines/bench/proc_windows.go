package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGetProcessMemInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
	procQueryWorkingSet   = kernel32.NewProc("K32QueryWorkingSet")
)

// PROCESS_MEMORY_COUNTERS_EX
type memCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
	PrivateUsage               uintptr
}

func tree(root int) []Proc {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	all := map[int]Proc{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		all[int(e.ProcessID)] = Proc{PID: int(e.ProcessID), PPID: int(e.ParentProcessID), Name: windows.UTF16ToString(e.ExeFile[:])}
	}
	if _, ok := all[root]; !ok {
		return nil
	}
	in := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, p := range all {
			if !in[pid] && in[p.PPID] && pid != p.PPID {
				in[pid], changed = true, true
			}
		}
	}
	var out []Proc
	for pid := range in {
		p := all[pid]
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, uint32(pid))
		if err == nil {
			var mc memCounters
			mc.CB = uint32(unsafe.Sizeof(mc))
			if r, _, _ := procGetProcessMemInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mc)), uintptr(mc.CB)); r != 0 {
				p.RSS, p.Private = uint64(mc.WorkingSetSize), uint64(mc.PrivateUsage)
			}
			p.PrivateWS = privateWorkingSet(h)
			windows.CloseHandle(h)
		}
		out = append(out, p)
	}
	return out
}

// privateWorkingSet counts the working-set pages that aren't shared, which is
// what Task Manager's default "Memory" column shows.
func privateWorkingSet(h windows.Handle) uint64 {
	n := 1 << 16
	for tries := 0; tries < 5; tries++ {
		buf := make([]uintptr, n+1)
		r, _, err := procQueryWorkingSet.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))*unsafe.Sizeof(buf[0]))
		if r == 0 {
			if err == windows.ERROR_BAD_LENGTH {
				n = int(buf[0]) + 4096
				continue
			}
			return 0
		}
		var private uint64
		for _, info := range buf[1 : 1+int(buf[0])] {
			if info&(1<<8) == 0 { // Shared bit
				private++
			}
		}
		return private * 4096
	}
	return 0
}

func killTree(root int) {
	for _, p := range tree(root) {
		if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(p.PID)); err == nil {
			windows.TerminateProcess(h, 1)
			windows.CloseHandle(h)
		}
	}
}

func osVersion() string {
	v := windows.RtlGetVersion()
	var ms struct {
		Length               uint32
		MemoryLoad           uint32
		TotalPhys            uint64
		AvailPhys            uint64
		TotalPageFile        uint64
		AvailPageFile        uint64
		TotalVirtual         uint64
		AvailVirtual         uint64
		AvailExtendedVirtual uint64
	}
	ms.Length = uint32(unsafe.Sizeof(ms))
	kernel32.NewProc("GlobalMemoryStatusEx").Call(uintptr(unsafe.Pointer(&ms)))
	return fmt.Sprintf("Windows %d.%d.%d / %d MB RAM", v.MajorVersion, v.MinorVersion, v.BuildNumber, ms.TotalPhys>>20)
}
