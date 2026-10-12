package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func tree(root int) []Proc {
	ents, _ := os.ReadDir("/proc")
	all := map[int]Proc{}
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		s := string(b)
		open, close := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
		if open < 0 || close < 0 {
			continue
		}
		f := strings.Fields(s[close+2:])
		ppid, _ := strconv.Atoi(f[1])
		all[pid] = Proc{PID: pid, PPID: ppid, Name: s[open+1 : close]}
	}
	if _, ok := all[root]; !ok {
		return nil
	}
	in := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, p := range all {
			if !in[pid] && in[p.PPID] {
				in[pid], changed = true, true
			}
		}
	}
	var out []Proc
	for pid := range in {
		p := all[pid]
		if f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/smaps_rollup"); err == nil {
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				k, v, ok := strings.Cut(sc.Text(), ":")
				if !ok {
					continue
				}
				fs := strings.Fields(v)
				if len(fs) == 0 {
					continue
				}
				kb, _ := strconv.ParseUint(fs[0], 10, 64)
				switch k {
				case "Rss":
					p.RSS = kb * 1024
				case "Pss":
					p.PSS = kb * 1024
				case "Private_Clean", "Private_Dirty":
					p.Private += kb * 1024
				}
			}
			f.Close()
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
	out := ""
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(l, "PRETTY_NAME="); ok {
				out = strings.Trim(v, `"`)
			}
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		out += " / " + strings.Fields(strings.SplitN(string(b), "\n", 2)[0])[1] + " kB RAM"
	}
	return out
}
