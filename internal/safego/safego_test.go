package safego

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestGoRecoversAndReports(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(old)

	type got struct {
		name  string
		value any
		stack string
	}
	heard := make(chan got, 1)
	SetHandler(func(name string, value any, stack []byte) { heard <- got{name, value, string(stack)} })
	defer SetHandler(nil)

	Go("test loop", func() { panic("boom") })

	select {
	case g := <-heard:
		if g.name != "test loop" || g.value != "boom" {
			t.Fatalf("heard %q %v", g.name, g.value)
		}
		if !strings.Contains(g.stack, "safego_test.go") {
			t.Fatalf("the stack doesn't name the panicking function:\n%s", g.stack)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the panic was never reported")
	}
	if line := buf.String(); !strings.Contains(line, "panic recovered") || !strings.Contains(line, "goroutine=\"test loop\"") {
		t.Fatalf("log line: %s", line)
	}
}

func TestGoWithoutPanicReportsNothing(t *testing.T) {
	called := false
	SetHandler(func(string, any, []byte) { called = true })
	defer SetHandler(nil)
	done := make(chan struct{})
	Go("quiet", func() { close(done) })
	<-done
	time.Sleep(10 * time.Millisecond)
	if called {
		t.Fatal("reported a panic that never happened")
	}
}

func TestRecoverInAnHTTPStyleHandler(t *testing.T) {
	var name string
	SetHandler(func(n string, _ any, _ []byte) { name = n })
	defer SetHandler(nil)
	func() {
		defer Recover("image proxy")
		var m map[string]int
		m["x"] = 1 // a nil map write panics
	}()
	if name != "image proxy" {
		t.Fatalf("heard %q", name)
	}
}
