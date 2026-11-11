package plugins

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"time"
)

// ChildEnv marks Peli's binary as started to run one plugin call.
const ChildEnv = "PELI_PLUGIN_SANDBOX"

// exitMemory is the child's exit code when it goes over its memory limit
// and can't stop the plugin in time to say so.
const exitMemory = 3

// maxJob caps the job the child reads: the plugin's code and its query.
const maxJob = 32 << 20

// reply is what the child writes to its stdout: the streams, or an error.
type reply struct {
	Streams []Stream    `json:"streams,omitempty"`
	Error   *replyError `json:"error,omitempty"`
}

type replyError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeChild runs one plugin call and exits, if this process was started as
// a sandbox (ChildEnv); otherwise it returns at once. main calls it first,
// before anything else starts; so does TestMain.
func ServeChild() {
	if os.Getenv(ChildEnv) != "1" {
		return
	}
	os.Exit(child(os.Stdin, os.Stdout, os.Stderr))
}

func child(in io.Reader, out, logs io.Writer) int {
	var job Job
	data, err := io.ReadAll(io.LimitReader(in, maxJob+1))
	if err != nil || len(data) > maxJob || json.Unmarshal(data, &job) != nil {
		write(out, reply{Error: &replyError{Code: CodeCrashed, Message: "the sandbox got no job"}})
		return 1
	}
	limits := job.Limits
	if limits.Timeout <= 0 {
		limits.Timeout = DefaultLimits.Timeout
	}
	if limits.Memory <= 0 {
		limits.Memory = DefaultLimits.Memory
	}
	if limits.Requests <= 0 {
		limits.Requests = DefaultLimits.Requests
	}
	if limits.Body <= 0 {
		limits.Body = DefaultLimits.Body
	}
	job.Limits = limits

	// The GC works harder as the heap nears the limit; the watchdog stops
	// the plugin once it's over.
	debug.SetMemoryLimit(limits.Memory)
	runtime.GOMAXPROCS(min(runtime.GOMAXPROCS(0), 2))

	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	ctx, stop := context.WithTimeoutCause(ctx, limits.Timeout, ErrTimeout)
	defer stop()
	go watchMemory(ctx, limits.Memory, cancel, out)

	if !logging() {
		logs = nil
	}
	streams, err := run(ctx, job, logs)
	if err != nil {
		write(out, reply{Error: &replyError{Code: codeOf(err), Message: err.Error()}})
		return 0
	}
	write(out, reply{Streams: streams})
	return 0
}

// logging is whether plugins' console output goes to the child's stderr,
// which the host passes on: only when $PELI_PLUGIN_LOG=1.
func logging() bool { return os.Getenv("PELI_PLUGIN_LOG") == "1" }

func write(out io.Writer, r reply) {
	_ = json.NewEncoder(out).Encode(r)
}

// watchMemory stops the call once the heap goes over limit: first by
// interrupting the plugin (through ctx's cause), and if that hasn't ended
// the call a second later, by exiting.
func watchMemory(ctx context.Context, limit int64, cancel context.CancelCauseFunc, out io.Writer) {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		metrics.Read(sample)
		if sample[0].Value.Kind() != metrics.KindUint64 || int64(sample[0].Value.Uint64()) <= limit {
			continue
		}
		cancel(ErrMemory)
		time.AfterFunc(time.Second, func() {
			write(out, reply{Error: &replyError{Code: CodeMemory, Message: ErrMemory.Error()}})
			os.Exit(exitMemory)
		})
		return
	}
}
