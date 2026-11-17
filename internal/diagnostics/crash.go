package diagnostics

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// KeepCrashes is how many crash files are kept, the newest.
const KeepCrashes = 5

// crashLayout is the name of a crash file: the launch it belongs to.
const crashLayout = "20060102-150405"

// Crash is a crash file left by a run that ended in a Go panic or fatal
// error (debug.SetCrashOutput writes the trace into it).
type Crash struct {
	// Time is when the file was last written: when that run crashed.
	Time time.Time `json:"time"`
	Name string    `json:"name"`
	// Previous is true when the crash ended the run just before this one.
	Previous bool `json:"previous"`
}

// crashFiles is the crash directory's .txt files, oldest first (the names
// sort by launch time).
func crashFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".txt") {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	return names
}

// openCrashFile tidies dir and opens this run's crash file in it.
//
// Every launch makes a file, and it stays empty unless the run crashes. So
// at launch the empty ones are removed (the runs that ended well), and of the
// rest only the newest KeepCrashes stay. The returned crash is the newest
// kept one, if any, and whether it belongs to the run just before.
func openCrashFile(dir string, now time.Time) (*os.File, *Crash, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	names := crashFiles(dir)
	var kept []string
	for _, name := range names {
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if info.Size() == 0 {
			os.Remove(path)
			continue
		}
		kept = append(kept, name)
	}
	previous := len(names) > 0 && len(kept) > 0 && kept[len(kept)-1] == names[len(names)-1]
	for len(kept) > KeepCrashes-1 { // room for this run's file
		os.Remove(filepath.Join(dir, kept[0]))
		kept = kept[1:]
	}
	var last *Crash
	if len(kept) > 0 {
		last = crashAt(dir, kept[len(kept)-1])
		if last != nil {
			last.Previous = previous
		}
	}
	name := now.Format(crashLayout) + ".txt"
	for i := 1; slices.Contains(names, name); i++ {
		name = now.Format(crashLayout) + "-" + string(rune('a'+i-1)) + ".txt"
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	return f, last, err
}

func crashAt(dir, name string) *Crash {
	info, err := os.Stat(filepath.Join(dir, name))
	if err != nil || info.Size() == 0 {
		return nil
	}
	return &Crash{Time: info.ModTime(), Name: name}
}
