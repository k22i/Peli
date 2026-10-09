package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// mpvEvent is any line mpv pushes without a request_id: property changes
// ("property-change") and core events ("file-loaded", "end-file", ...).
type mpvEvent struct {
	Event string          `json:"event"`
	ID    int64           `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	// end-file
	Reason    string `json:"reason,omitempty"`
	FileError string `json:"file_error,omitempty"`
}

type mpvReply struct {
	Error     string          `json:"error"`
	Data      json.RawMessage `json:"data"`
	RequestID int64           `json:"request_id"`
}

// ipcClient speaks mpv's JSON IPC protocol: one JSON object per line in each
// direction, replies matched to commands by request_id.
type ipcClient struct {
	conn    net.Conn
	nextID  atomic.Int64
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[int64]chan mpvReply
	closed  bool

	events chan mpvEvent
}

// dialIPC connects to mpv's --input-ipc-server endpoint, retrying while mpv
// starts up and creates the socket / named pipe.
func dialIPC(path string, timeout time.Duration) (*ipcClient, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := dialEndpoint(path)
		if err == nil {
			c := &ipcClient{
				conn:    conn,
				pending: map[int64]chan mpvReply{},
				events:  make(chan mpvEvent, 256),
			}
			go c.readLoop()
			return c, nil
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("connect to mpv ipc %s: %w", path, lastErr)
}

func (c *ipcClient) readLoop() {
	sc := bufio.NewScanner(c.conn)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var probe struct {
			Event     string `json:"event"`
			RequestID *int64 `json:"request_id"`
		}
		if err := json.Unmarshal(line, &probe); err != nil {
			continue
		}
		if probe.Event == "" && probe.RequestID != nil {
			var r mpvReply
			_ = json.Unmarshal(line, &r)
			c.mu.Lock()
			ch := c.pending[r.RequestID]
			delete(c.pending, r.RequestID)
			c.mu.Unlock()
			if ch != nil {
				ch <- r
			}
			continue
		}
		var ev mpvEvent
		if json.Unmarshal(line, &ev) == nil && ev.Event != "" {
			select {
			case c.events <- ev:
			default: // drop rather than block mpv if nobody is draining
			}
		}
	}
	c.mu.Lock()
	c.closed = true
	for id, ch := range c.pending {
		ch <- mpvReply{Error: "connection closed", RequestID: id}
		delete(c.pending, id)
	}
	c.mu.Unlock()
	close(c.events)
}

// command sends {"command": args} and waits for the matching reply.
func (c *ipcClient) command(args ...any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan mpvReply, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("mpv ipc closed")
	}
	c.pending[id] = ch
	c.mu.Unlock()

	msg, err := json.Marshal(map[string]any{"command": args, "request_id": id})
	if err != nil {
		return nil, err
	}
	c.writeMu.Lock()
	_, err = c.conn.Write(append(msg, '\n'))
	c.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Error != "success" {
			return r.Data, fmt.Errorf("mpv %v: %s", args, r.Error)
		}
		return r.Data, nil
	case <-time.After(5 * time.Second):
		return nil, fmt.Errorf("mpv %v: timed out", args)
	}
}

func (c *ipcClient) getProperty(name string, out any) error {
	data, err := c.command("get_property", name)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (c *ipcClient) close() error { return c.conn.Close() }
