package diagnostics

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// RingLines is how many log lines the ring keeps: about the last few minutes
// of a busy session, a few hundred KB.
const RingLines = 2000

// Ring is the last log lines in memory (#127), so a device can share what
// happened without a Mac on its console. It is an io.Writer: each Write is
// one line (a slog text record), split again on newlines to be safe.
type Ring struct {
	mu    sync.Mutex
	lines []string
	next  int
	full  bool
}

// NewRing keeps the last n lines.
func NewRing(n int) *Ring {
	if n < 1 {
		n = 1
	}
	return &Ring{lines: make([]string, n)}
}

func (r *Ring) Write(p []byte) (int, error) {
	text := strings.TrimRight(string(p), "\n")
	r.mu.Lock()
	for line := range strings.SplitSeq(text, "\n") {
		r.lines[r.next] = line
		r.next = (r.next + 1) % len(r.lines)
		if r.next == 0 {
			r.full = true
		}
	}
	r.mu.Unlock()
	return len(p), nil
}

// Lines is what the ring holds, oldest first.
func (r *Ring) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.full {
		return append([]string(nil), r.lines[:r.next]...)
	}
	out := make([]string, 0, len(r.lines))
	out = append(out, r.lines[r.next:]...)
	return append(out, r.lines[:r.next]...)
}

// WriteFile writes the ring to path, replacing it whole (a temporary file,
// then a rename, so a crash mid-write leaves the old file).
func (r *Ring) WriteFile(path string) error {
	var buf bytes.Buffer
	for _, line := range r.Lines() {
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NewHandler is slog's text handler writing to both out (stderr, for the
// console) and the ring.
func NewHandler(out io.Writer, ring *Ring) slog.Handler {
	return slog.NewTextHandler(io.MultiWriter(out, ring), &slog.HandlerOptions{Level: slog.LevelInfo})
}
