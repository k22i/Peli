package diagnostics

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestRingKeepsTheLastLines(t *testing.T) {
	r := NewRing(3)
	if got := r.Lines(); len(got) != 0 {
		t.Fatalf("empty ring: %q", got)
	}
	for i := range 5 {
		fmt.Fprintf(r, "line %d\n", i)
	}
	if got, want := r.Lines(), []string{"line 2", "line 3", "line 4"}; !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	r.Write([]byte("a\nb\n"))
	if got, want := r.Lines(), []string{"line 4", "a", "b"}; !slices.Equal(got, want) {
		t.Fatalf("multi-line write: got %q, want %q", got, want)
	}
}

func TestRingHandlerTeesAndWritesTheFile(t *testing.T) {
	r := NewRing(10)
	var stderr strings.Builder
	log := slog.New(NewHandler(&stderr, r))
	log.Info("hello", "n", 1)
	log.Warn("second")
	if !strings.Contains(stderr.String(), "msg=hello n=1") {
		t.Fatalf("stderr: %q", stderr.String())
	}
	lines := r.Lines()
	if len(lines) != 2 || !strings.Contains(lines[0], "msg=hello") || !strings.Contains(lines[1], "level=WARN") {
		t.Fatalf("ring: %q", lines)
	}
	path := filepath.Join(t.TempDir(), "logs", "last.txt")
	if err := r.WriteFile(path); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Count(string(data), "\n") != 2 {
		t.Fatalf("file: %q", data)
	}
}

func TestCrashFilesRotate(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	write := func(name, body string) {
		os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644)
	}
	// Seven runs that crashed, two that didn't (empty files).
	for i := range 7 {
		write(at.Add(time.Duration(i)*time.Minute).Format(crashLayout)+".txt", "panic: boom")
	}
	write(at.Add(-time.Hour).Format(crashLayout)+".txt", "")

	f, last, err := openCrashFile(dir, at.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	names := crashFiles(dir)
	if len(names) != KeepCrashes {
		t.Fatalf("kept %d files, want %d: %q", len(names), KeepCrashes, names)
	}
	if names[0] != at.Add(3*time.Minute).Format(crashLayout)+".txt" {
		t.Fatalf("the oldest kept is %s", names[0])
	}
	if names[len(names)-1] != at.Add(time.Hour).Format(crashLayout)+".txt" {
		t.Fatalf("this run's file is missing: %q", names)
	}
	if last == nil || last.Name != at.Add(6*time.Minute).Format(crashLayout)+".txt" || !last.Previous {
		t.Fatalf("last crash: %+v", last)
	}

	// The run after that one ended well: its empty file goes, and the crash
	// is still the last one, but not the previous run's.
	f, last, err = openCrashFile(dir, at.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if last == nil || last.Previous {
		t.Fatalf("after a clean run: %+v", last)
	}
	if names := crashFiles(dir); len(names) != KeepCrashes {
		t.Fatalf("after a clean run: %q", names)
	}
}

func TestStartFindsThePreviousCrash(t *testing.T) {
	dir := t.TempDir()
	s := New(Options{Dir: dir, Ring: NewRing(10)})
	Start(s, time.Now())
	if s.LastCrash() != nil {
		t.Fatal("a crash on the first launch")
	}
	// What the runtime would write when that run crashed.
	names := crashFiles(filepath.Join(dir, "crash"))
	os.WriteFile(filepath.Join(dir, "crash", names[0]), []byte("fatal error: boom"), 0o644)
	os.WriteFile(LastLog(s), []byte("the crashed run's log\n"), 0o644)

	s2 := New(Options{Dir: dir, Ring: NewRing(10)})
	Start(s2, time.Now().Add(time.Second))
	c := s2.LastCrash()
	if c == nil || !c.Previous || c.Name != names[0] {
		t.Fatalf("last crash: %+v", c)
	}
	if data, _ := os.ReadFile(previousLog(s2)); string(data) != "the crashed run's log\n" {
		t.Fatalf("previous log: %q", data)
	}
}

func TestShareLogsSendsTheHeaderLogAndCrash(t *testing.T) {
	dir := t.TempDir()
	ring := NewRing(10)
	p := &fakePlatform{}
	s := New(Options{Dir: dir, Ring: ring, Platform: p})
	os.MkdirAll(filepath.Join(dir, "crash"), 0o755)
	os.WriteFile(filepath.Join(dir, "crash", "20261117-100000.txt"), []byte("panic: boom"), 0o644)
	Start(s, time.Now())
	slog.New(NewHandler(&strings.Builder{}, ring)).Info("a line")
	if err := s.ShareLogs(); err != nil {
		t.Fatal(err)
	}
	if len(p.shared) != 2 {
		t.Fatalf("shared %q", p.shared)
	}
	log, _ := os.ReadFile(p.shared[0])
	for _, want := range []string{"Device: iPhone test", "Memory: available=100MiB", "Last crash:", "msg=\"a line\""} {
		if !strings.Contains(string(log), want) {
			t.Errorf("shared log lacks %q:\n%s", want, log)
		}
	}
	if crash, _ := os.ReadFile(p.shared[1]); string(crash) != "panic: boom" {
		t.Fatalf("crash file: %q", crash)
	}
}

func TestReportIsRateLimited(t *testing.T) {
	s := New(Options{Dir: t.TempDir()})
	now := time.Now()
	n := 0
	for range 30 {
		if s.allowReport(now) {
			n++
		}
	}
	if n != reportsPerMinute {
		t.Fatalf("%d got through, want %d", n, reportsPerMinute)
	}
	if !s.allowReport(now.Add(61 * time.Second)) {
		t.Fatal("still limited a minute later")
	}
}

func TestLoopGuard(t *testing.T) {
	var r recovery
	t0 := time.Now()
	steps := []struct {
		after time.Duration
		want  Action
	}{
		{0, Reload},
		{3 * time.Minute, Reload}, // not a loop
		{3*time.Minute + 10*time.Second, ReloadHome}, // twice within 30 s
		{3*time.Minute + 50*time.Second, ErrorPage},  // a third within two minutes
		{15 * time.Minute, Reload},                   // long after: start over
	}
	for i, step := range steps {
		got, n := r.died(t0.Add(step.after))
		if got != step.want || n != i+1 {
			t.Fatalf("death %d: got %v (n=%d), want %v", i+1, got, n, step.want)
		}
	}
}

func TestRecoveryURL(t *testing.T) {
	cases := []struct {
		current, route string
		action         Action
		want           string
	}{
		{"wails://localhost/#/movies", "/title/movie/tt1", Reload, "wails://localhost/?peli-recovered=reload#/title/movie/tt1"},
		{"wails://localhost/#/movies?genre=Drama", "", Reload, "wails://localhost/?peli-recovered=reload#/movies?genre=Drama"},
		{"", "", Reload, "wails://localhost/?peli-recovered=reload#/"},
		{"wails://localhost/#/anime", "/anime", ReloadHome, "wails://localhost/?peli-recovered=home#/"},
	}
	for _, c := range cases {
		if got := recoveryURL(c.current, c.route, c.action); got != c.want {
			t.Errorf("recoveryURL(%q, %q, %v) = %q, want %q", c.current, c.route, c.action, got, c.want)
		}
	}
}

func TestTerminatedLogsAndAnswers(t *testing.T) {
	ring := NewRing(50)
	old := slog.Default()
	slog.SetDefault(slog.New(NewHandler(&strings.Builder{}, ring)))
	defer slog.SetDefault(old)
	s := New(Options{Dir: t.TempDir(), Ring: ring})
	s.SetRoute("/title/series/tt2")
	action, url := Terminated(s, "wails://localhost/#/player", time.Now())
	if action != Reload || url != "wails://localhost/?peli-recovered=reload#/title/series/tt2" {
		t.Fatalf("got %v %q", action, url)
	}
	if !slices.ContainsFunc(ring.Lines(), func(l string) bool {
		return strings.Contains(l, "webview: content process terminated (n=1)")
	}) {
		t.Fatalf("log: %q", ring.Lines())
	}
	if _, err := os.Stat(LastLog(s)); err != nil {
		t.Fatal("the log wasn't written out")
	}
	Terminated(s, "", time.Now())
	if action, url := Terminated(s, "", time.Now()); action != ErrorPage || url != "" {
		t.Fatalf("third: %v %q", action, url)
	}
}

func TestDevCrashNeedsADevBuild(t *testing.T) {
	s := New(Options{Dir: t.TempDir()})
	if err := s.DevCrash("panic"); err != ErrNotDev {
		t.Fatalf("got %v", err)
	}
}

type fakePlatform struct{ shared []string }

func (p *fakePlatform) Share(paths []string) error     { p.shared = paths; return nil }
func (p *fakePlatform) Memory() (uint64, uint64, bool) { return 100 << 20, 300 << 20, true }
func (p *fakePlatform) Device() string                 { return "iPhone test" }
