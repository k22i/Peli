package plugins

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

// These run the sandbox as the app does: a child process (this test
// binary, through TestMain), with its limits enforced there.

func runChild(t *testing.T, code string, limits Limits) ([]Stream, error) {
	t.Helper()
	return NewRunner().Run(t.Context(), Job{ID: "child", Code: code, Query: movie, Limits: limits, UserAgent: "Peli/test"})
}

func TestRunnerRunsInChild(t *testing.T) {
	code, err := os.ReadFile("testdata/offline.js")
	if err != nil {
		t.Fatal(err)
	}
	streams, err := runChild(t, string(code), testLimits)
	if err != nil {
		t.Fatal(err)
	}
	if len(streams) != 2 || streams[0].URL != "https://cdn.example.com/v/1?id=550" {
		t.Errorf("got %+v", streams)
	}
}

func TestRunnerErrorsKeepTheirKind(t *testing.T) {
	_, err := runChild(t, `module.exports.getStreams = () => Promise.reject(new Error("site down"));`, testLimits)
	if !errors.Is(err, ErrFailed) || err.Error() != "plugins: plugin failed: Error: site down" {
		t.Errorf("got %v", err)
	}
	_, err = runChild(t, `nope(`, testLimits)
	if !errors.Is(err, ErrInvalidPlugin) {
		t.Errorf("got %v, want ErrInvalidPlugin", err)
	}
}

func TestRunnerTimeout(t *testing.T) {
	limits := testLimits
	limits.Timeout = 500 * time.Millisecond
	start := time.Now()
	_, err := runChild(t, `module.exports.getStreams = () => { for (;;) {} };`, limits)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("got %v, want ErrTimeout", err)
	}
	if took := time.Since(start); took > limits.Timeout+grace {
		t.Errorf("took %v", took)
	}
}

// A plugin that allocates without end is stopped at its memory limit, and
// the app's own process never holds that memory.
func TestRunnerMemoryLimit(t *testing.T) {
	limits := testLimits
	limits.Memory = 64 << 20
	limits.Timeout = 20 * time.Second
	start := time.Now()
	_, err := runChild(t, `module.exports.getStreams = () => {
		const hoard = [];
		for (;;) hoard.push(new Array(10000).fill("x".repeat(16) + hoard.length));
	};`, limits)
	if !errors.Is(err, ErrMemory) {
		t.Fatalf("got %v, want ErrMemory", err)
	}
	if took := time.Since(start); took > 10*time.Second {
		t.Errorf("took %v to stop", took)
	}
}

// Cancelling the call (the user left the picker) kills the child.
func TestRunnerCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(200*time.Millisecond, cancel)
	start := time.Now()
	_, err := NewRunner().Run(ctx, Job{ID: "child", Code: `module.exports.getStreams = () => { for (;;) {} };`, Query: movie, Limits: testLimits})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("took %v", took)
	}
}

// The child's environment holds nothing of the parent's.
func TestChildEnvironment(t *testing.T) {
	t.Setenv("PELI_SECRET_FOR_TEST", "leak")
	for _, kv := range childEnv() {
		if kv == "PELI_SECRET_FOR_TEST=leak" {
			t.Fatal("the child gets the parent's environment")
		}
	}
	if childEnv()[0] != ChildEnv+"=1" {
		t.Errorf("env %v", childEnv())
	}
}

func TestRunnerCrash(t *testing.T) {
	r := NewRunner()
	r.Command = func(ctx context.Context) (*exec.Cmd, error) {
		// A child that dies without answering (see TestMain).
		return exec.CommandContext(ctx, os.Args[0], "crash"), nil
	}
	_, err := r.Run(t.Context(), Job{Code: `module.exports.getStreams = () => []`, Limits: testLimits})
	if !errors.Is(err, ErrCrashed) {
		t.Errorf("got %v, want ErrCrashed", err)
	}
}
