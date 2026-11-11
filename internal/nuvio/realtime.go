package nuvio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Supabase Realtime, as watch parties use it (ADR-0051): one websocket to
// /realtime/v1/websocket speaking Phoenix's channel protocol (JSON objects
// of topic, event, payload, ref and join_ref), and one private channel on
// it whose members broadcast to each other and track their presence. The
// session's access token joins it, so only the party's members get in.

// Realtime timing: Phoenix drops a socket that sends no heartbeat for 60 s.
const (
	heartbeatEvery = 25 * time.Second
	// How often the access token is checked for a newer one to hand over.
	tokenEvery  = 4 * time.Minute
	rejoinFirst = time.Second
	rejoinMax   = 30 * time.Second
	writeWithin = 10 * time.Second
)

// ErrNotJoined means the channel isn't joined yet, or lost its connection:
// what was sent is dropped, as Nuvio's apps drop it, and the state request
// on joining again catches up.
var ErrNotJoined = errors.New("nuvio: realtime channel not joined")

// ChannelHandler gets what arrives on a channel, on the channel's own
// goroutine, one call at a time. Any may be nil.
type ChannelHandler struct {
	// Broadcast is a message another member (or the backend) sent.
	Broadcast func(event string, payload json.RawMessage)
	// Presence is who came and went, by presence key, with what each
	// tracked. Joining sends everyone there as joins.
	Presence func(joins, leaves map[string]json.RawMessage)
	// Connected is true once the channel is joined, false when the
	// connection drops (it joins again by itself).
	Connected func(bool)
}

// Channel is a Realtime channel kept joined until Close: it reconnects with
// backoff and joins again whenever the connection drops.
type Channel struct {
	c       *Client
	topic   string
	key     string
	token   func(context.Context) (string, error)
	handler ChannelHandler
	stop    context.CancelFunc
	done    chan struct{}

	mu      sync.Mutex
	conn    *websocket.Conn
	joinRef string
	joined  bool
	ref     int
	sentTok string
}

// OpenChannel joins the private channel topic ("watch-party:<id>") with
// presence key presenceKey, and keeps it joined until Close. token returns
// the session's access token, fresh, each time it's needed.
func (c *Client) OpenChannel(topic, presenceKey string, token func(context.Context) (string, error), handler ChannelHandler) *Channel {
	ctx, stop := context.WithCancel(context.Background())
	ch := &Channel{
		c: c, topic: "realtime:" + topic, key: presenceKey, token: token, handler: handler,
		stop: stop, done: make(chan struct{}),
	}
	go ch.run(ctx)
	return ch
}

// Close leaves the channel and closes its connection, waiting for its
// goroutine to finish. No handler is called after it returns.
func (ch *Channel) Close() {
	ch.stop()
	<-ch.done
}

// Send broadcasts payload to the channel's other members as event.
func (ch *Channel) Send(event string, payload any) error {
	return ch.push("broadcast", map[string]any{"type": "broadcast", "event": event, "payload": payload})
}

// Track sets what this member's presence carries.
func (ch *Channel) Track(payload any) error {
	return ch.push("presence", map[string]any{"type": "presence", "event": "track", "payload": payload})
}

// push sends event on the channel while it's joined.
func (ch *Channel) push(event string, payload any) error {
	ch.mu.Lock()
	if !ch.joined || ch.conn == nil {
		ch.mu.Unlock()
		return ErrNotJoined
	}
	conn, msg := ch.conn, ch.message(event, payload)
	ch.mu.Unlock()
	return write(conn, msg)
}

// phoenixMessage is one frame of Phoenix's protocol (vsn 1.0.0).
type phoenixMessage struct {
	Topic   string          `json:"topic"`
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
	Ref     *string         `json:"ref"`
	JoinRef *string         `json:"join_ref,omitempty"`
}

// message makes a frame for the channel's topic with the next ref. ch.mu is
// held.
func (ch *Channel) message(event string, payload any) map[string]any {
	ch.ref++
	return map[string]any{
		"topic": ch.topic, "event": event, "payload": payload,
		"ref": strconv.Itoa(ch.ref), "join_ref": ch.joinRef,
	}
}

func write(conn *websocket.Conn, msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeWithin)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func (ch *Channel) run(ctx context.Context) {
	defer close(ch.done)
	wait := rejoinFirst
	for ctx.Err() == nil {
		joinedAt, err := ch.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if !joinedAt.IsZero() && time.Since(joinedAt) > rejoinMax {
			wait = rejoinFirst
		}
		slog.Debug("realtime channel dropped", "err", err, "retry", wait)
		if sleep(ctx, wait) != nil {
			return
		}
		wait = min(wait*2, rejoinMax)
	}
}

// session connects, joins and reads until the connection drops or ctx ends.
// It returns when the channel was joined (zero if it never was).
func (ch *Channel) session(ctx context.Context) (joinedAt time.Time, err error) {
	token, err := ch.token(ctx)
	if err != nil {
		return time.Time{}, err
	}
	endpoint, err := ch.c.realtimeURL(ctx)
	if err != nil {
		return time.Time{}, err
	}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: ch.c.http.Transport},
		HTTPHeader: http.Header{"User-Agent": {ch.c.userAgent}},
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: realtime: %v", ErrUnreachable, err)
	}
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()

	// A join's ref is its join_ref, which every later frame of this join
	// carries.
	ch.mu.Lock()
	ch.conn = conn
	ch.joinRef = strconv.Itoa(ch.ref + 1)
	ch.sentTok = token
	join := ch.message("phx_join", map[string]any{
		"config": map[string]any{
			"broadcast":        map[string]any{"ack": false, "self": false},
			"presence":         map[string]any{"key": ch.key, "enabled": true},
			"postgres_changes": []any{},
			"private":          true,
		},
		"access_token": token,
	})
	joinRef := ch.joinRef
	ch.mu.Unlock()
	defer func() {
		ch.mu.Lock()
		wasJoined := ch.joined
		ch.conn, ch.joined = nil, false
		ch.mu.Unlock()
		if wasJoined && ch.handler.Connected != nil {
			ch.handler.Connected(false)
		}
	}()
	if err := write(conn, join); err != nil {
		return time.Time{}, err
	}

	// Heartbeats, and a newer token when the session is refreshed. A
	// heartbeat still unanswered at the next one means the socket is dead.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	beats := make(chan error, 1)
	var pending sync.Mutex
	unanswered := ""
	go func() {
		heartbeat, tokens := time.NewTicker(heartbeatEvery), time.NewTicker(tokenEvery)
		defer heartbeat.Stop()
		defer tokens.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				pending.Lock()
				dead := unanswered != ""
				pending.Unlock()
				if dead {
					beats <- errors.New("realtime: heartbeat unanswered")
					conn.CloseNow()
					return
				}
				ch.mu.Lock()
				if ch.conn != conn {
					ch.mu.Unlock()
					return
				}
				ch.ref++
				ref := strconv.Itoa(ch.ref)
				ch.mu.Unlock()
				pending.Lock()
				unanswered = ref
				pending.Unlock()
				if err := write(conn, map[string]any{"topic": "phoenix", "event": "heartbeat", "payload": map[string]any{}, "ref": ref}); err != nil {
					beats <- err
					return
				}
			case <-tokens.C:
				fresh, err := ch.token(ctx)
				ch.mu.Lock()
				if err != nil || fresh == ch.sentTok || ch.conn != conn || !ch.joined {
					ch.mu.Unlock()
					continue
				}
				ch.sentTok = fresh
				msg := ch.message("access_token", map[string]any{"access_token": fresh})
				ch.mu.Unlock()
				_ = write(conn, msg)
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			select {
			case beat := <-beats:
				err = beat
			default:
			}
			return joinedAt, err
		}
		var msg phoenixMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		slog.Debug("realtime message", "topic", msg.Topic, "event", msg.Event)
		if msg.Topic == "phoenix" {
			if msg.Event == "phx_reply" && msg.Ref != nil {
				pending.Lock()
				if *msg.Ref == unanswered {
					unanswered = ""
				}
				pending.Unlock()
			}
			continue
		}
		if msg.Topic != ch.topic {
			continue
		}
		switch msg.Event {
		case "phx_reply":
			if msg.Ref == nil || *msg.Ref != joinRef {
				continue
			}
			var reply struct {
				Status   string `json:"status"`
				Response struct {
					Reason string `json:"reason"`
				} `json:"response"`
			}
			json.Unmarshal(msg.Payload, &reply)
			if reply.Status != "ok" {
				return joinedAt, fmt.Errorf("realtime: join refused: %s", cmpOr(reply.Response.Reason, reply.Status))
			}
			ch.mu.Lock()
			ch.joined = true
			ch.mu.Unlock()
			joinedAt = time.Now()
			if ch.handler.Connected != nil {
				ch.handler.Connected(true)
			}
		case "phx_error", "phx_close":
			return joinedAt, fmt.Errorf("realtime: %s", msg.Event)
		case "system":
			var system struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			}
			json.Unmarshal(msg.Payload, &system)
			if system.Status == "error" {
				return joinedAt, fmt.Errorf("realtime: %s", system.Message)
			}
		case "broadcast":
			var b struct {
				Event   string          `json:"event"`
				Payload json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(msg.Payload, &b) == nil && ch.handler.Broadcast != nil {
				ch.handler.Broadcast(b.Event, b.Payload)
			}
		case "presence_state":
			if joins := presenceMetas(msg.Payload); ch.handler.Presence != nil {
				ch.handler.Presence(joins, map[string]json.RawMessage{})
			}
		case "presence_diff":
			var diff struct {
				Joins  json.RawMessage `json:"joins"`
				Leaves json.RawMessage `json:"leaves"`
			}
			if json.Unmarshal(msg.Payload, &diff) == nil && ch.handler.Presence != nil {
				ch.handler.Presence(presenceMetas(diff.Joins), presenceMetas(diff.Leaves))
			}
		}
	}
}

// presenceMetas reads Phoenix's presence map, {key: {metas: [{phx_ref,
// …tracked}]}}, as each key's newest tracked payload.
func presenceMetas(data json.RawMessage) map[string]json.RawMessage {
	var state map[string]struct {
		Metas []json.RawMessage `json:"metas"`
	}
	out := map[string]json.RawMessage{}
	if json.Unmarshal(data, &state) != nil {
		return out
	}
	for key, entry := range state {
		if n := len(entry.Metas); n > 0 {
			out[key] = entry.Metas[n-1]
		} else {
			out[key] = json.RawMessage("{}")
		}
	}
	return out
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// realtimeURL is the backend's Realtime websocket, with its publishable key.
func (c *Client) realtimeURL(ctx context.Context) (string, error) {
	base, key, err := c.publishableKey(ctx)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/realtime/v1/websocket"
	// Live answers 410 Gone without nuvio_realtime=1, which Nuvio's apps
	// send (seen 2026-11-11).
	u.RawQuery = url.Values{"nuvio_realtime": {"1"}, "apikey": {key}, "vsn": {"1.0.0"}}.Encode()
	return u.String(), nil
}
