package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	// grace is how long past its own limit a child gets to answer before
	// it's killed: it stops itself at the limit, so this is only for a
	// child stuck where the interrupt can't reach (a regexp, a big copy).
	grace = 2 * time.Second
	// maxReply caps what a child may write back.
	maxReply = 8 << 20
	// maxChildren caps the sandboxes running at once.
	maxChildren = 4
)

// Runner runs plugin calls, each in its own child process: Sinag's own
// binary started with ChildEnv, which runs the call and exits. The child
// gets an empty environment and no files beyond its stdin, stdout and
// stderr; a call over its limits, or a crash, ends that child only.
type Runner struct {
	// Command starts a child. By default it's this executable.
	Command func(ctx context.Context) (*exec.Cmd, error)
	slots   chan struct{}
}

// NewRunner returns a Runner that starts children from this executable.
func NewRunner() *Runner {
	return &Runner{Command: selfCommand, slots: make(chan struct{}, maxChildren)}
}

func selfCommand(ctx context.Context) (*exec.Cmd, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return exec.CommandContext(ctx, self), nil
}

// childEnv is all a child's environment holds: the marker, and what TLS
// and DNS need on Linux. Nothing of the user's (tokens, paths) gets in.
func childEnv() []string {
	env := []string{ChildEnv + "=1"}
	for _, name := range []string{"SSL_CERT_FILE", "SSL_CERT_DIR", "SINAG_PLUGIN_LOG", "TMPDIR", "SYSTEMROOT"} {
		if v, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+v)
		}
	}
	return env
}

// Run calls the plugin in job and returns its streams.
func (r *Runner) Run(ctx context.Context, job Job) ([]Stream, error) {
	if job.Limits.Timeout <= 0 {
		job.Limits.Timeout = DefaultLimits.Timeout
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	input, err := json.Marshal(job)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeoutCause(ctx, job.Limits.Timeout+grace, ErrTimeout)
	defer cancel()
	cmd, err := r.Command(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCrashed, err)
	}
	cmd.Env = childEnv()
	cmd.Dir = os.TempDir()
	cmd.Stdin = bytes.NewReader(input)
	stdout := &capped{max: maxReply}
	stderr := &capped{max: 64 << 10}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = time.Second
	runErr := cmd.Run()

	if logging() && stderr.Len() > 0 {
		for line := range strings.SplitSeq(strings.TrimRight(stderr.String(), "\n"), "\n") {
			log.Printf("plugins: %s: %s", job.ID, line)
		}
	}
	var out reply
	if err := json.NewDecoder(bytes.NewReader(stdout.Bytes())).Decode(&out); err != nil {
		switch {
		case errors.Is(context.Cause(ctx), ErrTimeout):
			return nil, ErrTimeout
		case ctx.Err() != nil:
			return nil, ctx.Err()
		}
		var exit *exec.ExitError
		if errors.As(runErr, &exit) && exit.ExitCode() == exitMemory {
			return nil, ErrMemory
		}
		return nil, ErrCrashed
	}
	if out.Error != nil {
		e := errorOf(out.Error.Code)
		msg := strings.TrimPrefix(out.Error.Message, e.Error())
		msg = strings.TrimPrefix(msg, ": ")
		if msg == "" {
			return nil, e
		}
		return nil, fmt.Errorf("%w: %s", e, msg)
	}
	if out.Streams == nil {
		out.Streams = []Stream{}
	}
	return out.Streams, nil
}

// capped keeps the first max bytes written to it and drops the rest.
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

var _ io.Writer = (*capped)(nil)
