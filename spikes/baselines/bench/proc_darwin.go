package main

/*
#include <libproc.h>
#include <sys/resource.h>
#include <sys/proc_info.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

// WebKit's WebContent / Networking / GPU processes are XPC services started by
// launchd, not children of the app. Activity Monitor attributes them to the app
// through the (private) "responsible pid", which we use the same way.
typedef pid_t (*resp_fn)(pid_t);
static pid_t responsible(pid_t pid) {
	static resp_fn fn = NULL;
	static int looked = 0;
	if (!looked) {
		fn = (resp_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
		looked = 1;
	}
	return fn ? fn(pid) : -1;
}

static int usage(pid_t pid, uint64_t *footprint, uint64_t *resident) {
	struct rusage_info_v4 ri;
	if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) return -1;
	*footprint = ri.ri_phys_footprint;
	*resident = ri.ri_resident_size;
	return 0;
}

static int bsdinfo(pid_t pid, int *ppid, char *name, int len) {
	struct proc_bsdinfo bi;
	if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof(bi)) != sizeof(bi)) return -1;
	*ppid = bi.pbi_ppid;
	strlcpy(name, bi.pbi_name[0] ? bi.pbi_name : bi.pbi_comm, len);
	return 0;
}
*/
import "C"

import (
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

func tree(root int) []Proc {
	n := C.proc_listallpids(nil, 0)
	pids := make([]C.int, n+64)
	n = C.proc_listallpids(unsafe.Pointer(&pids[0]), C.int(len(pids))*C.int(unsafe.Sizeof(pids[0])))
	all := map[int]Proc{}
	for _, p := range pids[:n] {
		var ppid C.int
		var name [64]C.char
		if C.bsdinfo(C.pid_t(p), &ppid, &name[0], 64) != 0 {
			continue
		}
		all[int(p)] = Proc{PID: int(p), PPID: int(ppid), Name: C.GoString(&name[0]), Responsible: int(C.responsible(C.pid_t(p)))}
	}
	if _, ok := all[root]; !ok {
		return nil
	}
	in := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, p := range all {
			if !in[pid] && (in[p.PPID] || p.Responsible == root) {
				in[pid], changed = true, true
			}
		}
	}
	var out []Proc
	for pid := range in {
		p := all[pid]
		var fp, rss C.uint64_t
		if C.usage(C.pid_t(pid), &fp, &rss) == 0 {
			p.Footprint, p.RSS = uint64(fp), uint64(rss)
		}
		out = append(out, p)
	}
	return out
}

func killTree(root int) {
	for _, p := range tree(root) {
		syscall.Kill(p.PID, syscall.SIGKILL)
	}
}

func osVersion() string {
	v, _ := exec.Command("sw_vers", "-productVersion").Output()
	m, _ := exec.Command("sysctl", "-n", "machdep.cpu.brand_string", "hw.memsize").Output()
	return "macOS " + strings.TrimSpace(string(v)) + " / " + strings.ReplaceAll(strings.TrimSpace(string(m)), "\n", " / ")
}
