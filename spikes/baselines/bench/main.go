// Command bench launches the baseline app N times and records, per run, when
// it got to each startup milestone (relative to the spawn) and how much memory
// the whole process tree uses once idle (app + webview helper processes).
//
//	bench -app bin/Staysh.app -runs 10 -label macos-shell -out results/macos-shell.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// Proc is one process of the app's tree. Fields that an OS doesn't have are 0.
type Proc struct {
	PID         int    `json:"pid"`
	PPID        int    `json:"ppid"`
	Name        string `json:"name"`
	Footprint   uint64 `json:"footprint,omitempty"`   // macOS phys_footprint (Activity Monitor "Memory")
	RSS         uint64 `json:"rss,omitempty"`         // resident set / working set
	PSS         uint64 `json:"pss,omitempty"`         // Linux proportional set size
	Private     uint64 `json:"private,omitempty"`     // Windows private bytes (commit); Linux private clean+dirty
	PrivateWS   uint64 `json:"privateWS,omitempty"`   // Windows private working set (Task Manager "Memory")
	Responsible int    `json:"responsible,omitempty"` // macOS responsible pid
}

type Sample struct {
	AfterPaintMs float64            `json:"afterPaintMs"`
	Procs        []Proc             `json:"procs"`
	TotalMB      map[string]float64 `json:"totalMB"`
}

type Run struct {
	N           int                `json:"n"`
	SpawnUs     int64              `json:"spawnUs"`
	Report      map[string]any     `json:"report"`
	MsFromSpawn map[string]float64 `json:"msFromSpawn"`
	Samples     []Sample           `json:"samples"`
	Error       string             `json:"error,omitempty"`
}

type Output struct {
	Label   string            `json:"label"`
	App     string            `json:"app"`
	Launch  string            `json:"launch"`
	Page    string            `json:"page"`
	Env     map[string]string `json:"env"`
	Host    map[string]any    `json:"host"`
	Runs    []Run             `json:"runs"`
	Summary map[string]any    `json:"summary"`
}

type envList []string

func (e *envList) String() string     { return strings.Join(*e, ",") }
func (e *envList) Set(v string) error { *e = append(*e, v); return nil }

func main() {
	app := flag.String("app", "", "app binary, or a .app bundle on macOS")
	runs := flag.Int("runs", 10, "launches")
	label := flag.String("label", "", "name for the results")
	out := flag.String("out", "", "results JSON")
	page := flag.String("page", "shell", "shell or home")
	launch := flag.String("launch", "exec", "exec (spawn the binary) or open (macOS LaunchServices)")
	samples := flag.String("samples", "5s,15s", "memory sample times after first paint")
	gap := flag.Duration("gap", 3*time.Second, "pause between runs")
	timeout := flag.Duration("timeout", 45*time.Second, "max wait for the first-paint report")
	var env envList
	flag.Var(&env, "env", "extra K=V for the app (repeatable)")
	flag.Parse()
	if *app == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}
	var offsets []time.Duration
	for _, s := range strings.Split(*samples, ",") {
		d, err := time.ParseDuration(strings.TrimSpace(s))
		if err != nil {
			log.Fatalf("bad -samples: %v", err)
		}
		offsets = append(offsets, d)
	}
	abs, _ := filepath.Abs(*app)
	o := Output{Label: *label, App: *app, Launch: *launch, Page: *page, Env: map[string]string{}, Host: hostInfo()}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		o.Env[k] = v
	}
	tmp, err := os.MkdirTemp("", "baseline-bench-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(tmp)

	for i := 1; i <= *runs; i++ {
		r := runOnce(i, abs, *launch, *page, env, tmp, offsets, *timeout)
		o.Runs = append(o.Runs, r)
		line := fmt.Sprintf("run %d:", i)
		if r.Error != "" {
			line += " ERROR " + r.Error
		}
		for _, k := range []string{"goInit", "windowShow", "fcp", "painted", "mpvReady"} {
			if v, ok := r.MsFromSpawn[k]; ok {
				line += fmt.Sprintf(" %s=%.0f", k, v)
			}
		}
		for _, s := range r.Samples {
			line += fmt.Sprintf(" | +%.0fs %s", s.AfterPaintMs/1000, fmtTotals(s.TotalMB))
		}
		log.Print(line)
		time.Sleep(*gap)
	}
	o.Summary = summarize(o.Runs)
	b, _ := json.MarshalIndent(o, "", "  ")
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		log.Fatal(err)
	}
	s, _ := json.MarshalIndent(o.Summary, "", "  ")
	fmt.Printf("== %s\n%s\n", *label, s)
}

func fmtTotals(t map[string]float64) string {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%.0f", k, t[k]))
	}
	return strings.Join(parts, " ")
}

func runOnce(n int, app, launch, page string, env []string, tmp string, offsets []time.Duration, timeout time.Duration) Run {
	r := Run{N: n}
	report := filepath.Join(tmp, fmt.Sprintf("report-%d.json", n))
	quit := filepath.Join(tmp, fmt.Sprintf("quit-%d", n))
	vars := append([]string{"BASELINE_REPORT=" + report, "BASELINE_QUIT_FILE=" + quit, "BASELINE_PAGE=" + page}, env...)
	logf, _ := os.Create(filepath.Join(tmp, fmt.Sprintf("app-%d.log", n)))
	defer logf.Close()

	var cmd *exec.Cmd
	switch launch {
	case "open":
		args := []string{"-n", "-F", "-a", app, "--stdout", logf.Name(), "--stderr", logf.Name()}
		for _, kv := range vars {
			args = append(args, "--env", kv)
		}
		cmd = exec.Command("open", args...)
	default:
		bin := app
		if strings.HasSuffix(app, ".app") {
			bin = macBundleExe(app)
		}
		cmd = exec.Command(bin)
		cmd.Env = append(os.Environ(), vars...)
		cmd.Stdout, cmd.Stderr = logf, logf
	}
	spawn := time.Now()
	r.SpawnUs = spawn.UnixMicro()
	if err := cmd.Start(); err != nil {
		r.Error = err.Error()
		return r
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()

	deadline := time.Now().Add(timeout)
	for {
		if b, err := os.ReadFile(report); err == nil && json.Unmarshal(b, &r.Report) == nil {
			break
		}
		if time.Now().After(deadline) {
			r.Error = "no report before timeout"
			killTree(cmd.Process.Pid)
			return r
		}
		time.Sleep(20 * time.Millisecond)
	}
	pid := int(r.Report["pid"].(float64))
	r.MsFromSpawn = relMarks(r.Report, r.SpawnUs)
	paintedAt := spawn.Add(time.Duration(r.MsFromSpawn["painted"] * float64(time.Millisecond)))

	for _, off := range offsets {
		time.Sleep(time.Until(paintedAt.Add(off)))
		procs := tree(pid)
		r.Samples = append(r.Samples, Sample{
			AfterPaintMs: float64(time.Since(paintedAt).Milliseconds()),
			Procs:        procs,
			TotalMB:      totals(procs, pid),
		})
	}
	// Late marks (e.g. Home posters decoded) land in the report file.
	if b, err := os.ReadFile(report); err == nil {
		var again map[string]any
		if json.Unmarshal(b, &again) == nil && again["late"] != nil {
			r.Report = again
			if late, ok := again["late"].(map[string]any); ok {
				if at, ok := late["at"].(float64); ok {
					r.MsFromSpawn["homeDecoded"] = at - float64(r.SpawnUs)/1000
				}
			}
		}
	}

	os.WriteFile(quit, nil, 0o644)
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
	}
	// Wait for the app and its helpers to go away before the next run.
	for i := 0; i < 100; i++ {
		if len(tree(pid)) == 0 {
			break
		}
		if i == 50 {
			killTree(pid)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return r
}

// relMarks turns the app's absolute marks into ms after the spawn.
func relMarks(rep map[string]any, spawnUs int64) map[string]float64 {
	out := map[string]float64{}
	if g, ok := rep["go"].(map[string]any); ok {
		for k, v := range g {
			out[k] = (v.(float64) - float64(spawnUs)) / 1000
		}
	}
	if p, ok := rep["page"].(map[string]any); ok {
		for _, k := range []string{"timeOrigin", "responseEnd", "scriptStart", "domContentLoaded", "mounted", "raf", "painted", "firstPaint", "fcp"} {
			if v, ok := p[k].(float64); ok && v > 0 {
				out[k] = v - float64(spawnUs)/1000
			}
		}
	}
	return out
}

// totals sums the tree. On macOS, "core" is the app plus WebKit's own
// processes; the rest are system services macOS attributes to any Cocoa app
// (text input, Metal shader compiler, audio sandbox helper, ...).
func totals(procs []Proc, root int) map[string]float64 {
	t := map[string]float64{}
	for _, p := range procs {
		if p.PID == root || strings.HasPrefix(p.Name, "com.apple.WebKit.") {
			t["footprintCore"] += float64(p.Footprint)
		}
		t["footprint"] += float64(p.Footprint)
		t["rss"] += float64(p.RSS)
		t["pss"] += float64(p.PSS)
		t["private"] += float64(p.Private)
		t["privateWS"] += float64(p.PrivateWS)
	}
	for k, v := range t {
		if v == 0 {
			delete(t, k)
		} else {
			t[k] = math.Round(v/1048576*10) / 10
		}
	}
	t["procs"] = float64(len(procs))
	return t
}

func stats(xs []float64) map[string]float64 {
	if len(xs) == 0 {
		return nil
	}
	s := slices.Clone(xs)
	slices.Sort(s)
	q := func(p float64) float64 { return s[int(math.Round(p*float64(len(s)-1)))] }
	return map[string]float64{"n": float64(len(s)), "min": s[0], "p50": q(0.5), "max": s[len(s)-1]}
}

// summarize reports run 1 on its own (first launch after build/boot/install)
// and the median of the rest (warm launches).
func summarize(runs []Run) map[string]any {
	out := map[string]any{}
	ok := []Run{}
	for _, r := range runs {
		if r.Error == "" {
			ok = append(ok, r)
		}
	}
	if len(ok) == 0 {
		return out
	}
	out["first"] = ok[0].MsFromSpawn
	warm := ok
	if len(ok) > 1 {
		warm = ok[1:]
	}
	marks := map[string]any{}
	for k := range ok[0].MsFromSpawn {
		var xs []float64
		for _, r := range warm {
			if v, ok := r.MsFromSpawn[k]; ok {
				xs = append(xs, math.Round(v*10)/10)
			}
		}
		marks[k] = stats(xs)
	}
	out["warm"] = marks
	mem := map[string]any{}
	for i := range ok[0].Samples {
		per := map[string][]float64{}
		for _, r := range ok {
			if i < len(r.Samples) {
				for k, v := range r.Samples[i].TotalMB {
					per[k] = append(per[k], v)
				}
			}
		}
		m := map[string]any{}
		for k, xs := range per {
			m[k] = stats(xs)
		}
		mem[fmt.Sprintf("+%.0fs", ok[0].Samples[i].AfterPaintMs/1000)] = m
	}
	out["memoryMB"] = mem
	return out
}

func hostInfo() map[string]any {
	h, _ := os.Hostname()
	_ = h // not recorded
	return map[string]any{"goos": runtime.GOOS, "goarch": runtime.GOARCH, "cpus": runtime.NumCPU(), "os": osVersion()}
}

func macBundleExe(app string) string {
	entries, _ := os.ReadDir(filepath.Join(app, "Contents", "MacOS"))
	for _, e := range entries {
		return filepath.Join(app, "Contents", "MacOS", e.Name())
	}
	return app
}
