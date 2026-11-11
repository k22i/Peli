package nuvio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// phoenix is a fake Realtime server: it answers joins and lets a test send
// and read frames on the connection open now.
type phoenix struct {
	t     *testing.T
	mu    sync.Mutex
	conns []*websocket.Conn
	joins []map[string]any
	query []string
	read  chan phoenixMessage
}

func newPhoenix(t *testing.T) (*phoenix, *Client) {
	p := &phoenix{t: t, read: make(chan phoenixMessage, 64)}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/nuvio", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"service":"nuvio","publishable_key":"pk"}`))
	})
	mux.HandleFunc("/realtime/v1/websocket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		p.mu.Lock()
		p.conns = append(p.conns, conn)
		p.query = append(p.query, r.URL.RawQuery)
		p.mu.Unlock()
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var msg phoenixMessage
			json.Unmarshal(data, &msg)
			if msg.Event == "phx_join" {
				var payload map[string]any
				json.Unmarshal(msg.Payload, &payload)
				p.mu.Lock()
				p.joins = append(p.joins, payload)
				p.mu.Unlock()
				p.write(conn, map[string]any{"topic": msg.Topic, "event": "phx_reply", "ref": *msg.Ref, "join_ref": *msg.Ref,
					"payload": map[string]any{"status": "ok", "response": map[string]any{}}})
				p.write(conn, map[string]any{"topic": msg.Topic, "event": "presence_state", "ref": nil,
					"payload": map[string]any{"friend": map[string]any{"metas": []any{map[string]any{"phx_ref": "x", "status": "ready"}}}}})
				continue
			}
			p.read <- msg
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return p, New(server.URL, "0.0.0-test")
}

func (p *phoenix) write(conn *websocket.Conn, msg any) {
	data, _ := json.Marshal(msg)
	conn.Write(context.Background(), websocket.MessageText, data)
}

func (p *phoenix) last() *websocket.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conns[len(p.conns)-1]
}

func TestChannel(t *testing.T) {
	p, c := newPhoenix(t)
	in := newInbox()
	ch := c.OpenChannel("watch-party:p1", "me", func(context.Context) (string, error) { return "jwt", nil }, in.handler())
	defer ch.Close()

	in.wait(t, "joined", func(e event) bool { return e.kind == "connected" })
	p.mu.Lock()
	join, query := p.joins[0], p.query[0]
	p.mu.Unlock()
	config, _ := join["config"].(map[string]any)
	presence, _ := config["presence"].(map[string]any)
	if join["access_token"] != "jwt" || config["private"] != true || presence["key"] != "me" {
		t.Errorf("join = %v", join)
	}
	if query != "apikey=pk&nuvio_realtime=1&vsn=1.0.0" {
		t.Errorf("query = %q", query)
	}
	if e := in.wait(t, "presence", func(e event) bool { return e.kind == "join" }); e.name != "friend" || string(e.payload) != `{"phx_ref":"x","status":"ready"}` {
		t.Errorf("presence = %+v", e)
	}

	// From another member.
	p.write(p.last(), map[string]any{"topic": "realtime:watch-party:p1", "event": "broadcast", "ref": nil,
		"payload": map[string]any{"type": "broadcast", "event": "state", "payload": map[string]any{"seq": 3}}})
	if e := in.wait(t, "broadcast", func(e event) bool { return e.kind == "broadcast" }); e.name != "state" || string(e.payload) != `{"seq":3}` {
		t.Errorf("broadcast = %+v", e)
	}
	p.write(p.last(), map[string]any{"topic": "realtime:watch-party:p1", "event": "presence_diff", "ref": nil,
		"payload": map[string]any{"joins": map[string]any{}, "leaves": map[string]any{"friend": map[string]any{"metas": []any{}}}}})
	in.wait(t, "left", func(e event) bool { return e.kind == "leave" && e.name == "friend" })

	// To the others, on this join.
	if err := ch.Send("chat", map[string]string{"body": "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := ch.Track(map[string]string{"status": "loading"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`{"event":"chat","payload":{"body":"hi"},"type":"broadcast"}`, `{"event":"track","payload":{"status":"loading"},"type":"presence"}`} {
		select {
		case msg := <-p.read:
			if string(msg.Payload) != want || msg.JoinRef == nil || *msg.JoinRef != "1" {
				t.Errorf("sent %s (join_ref %v), want %s", msg.Payload, msg.JoinRef, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("nothing sent")
		}
	}

	// The server drops the connection: the channel joins again by itself.
	p.last().CloseNow()
	in.wait(t, "dropped", func(e event) bool { return e.kind == "disconnected" })
	if err := ch.Send("state", map[string]int{}); err != ErrNotJoined {
		t.Errorf("send while dropped: %v", err)
	}
	joined := 0
	in.wait(t, "joined again", func(e event) bool {
		if e.kind == "connected" {
			joined++
		}
		return joined == 2
	})
	p.mu.Lock()
	joins := len(p.joins)
	p.mu.Unlock()
	if joins != 2 {
		t.Errorf("%d joins", joins)
	}
}

func TestChannelJoinRefused(t *testing.T) {
	p, c := newPhoenix(t)
	_ = p
	refused := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/nuvio", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"service":"nuvio","publishable_key":"pk"}`))
	})
	mux.HandleFunc("/realtime/v1/websocket", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		var msg phoenixMessage
		json.Unmarshal(data, &msg)
		reply, _ := json.Marshal(map[string]any{"topic": msg.Topic, "event": "phx_reply", "ref": *msg.Ref,
			"payload": map[string]any{"status": "error", "response": map[string]any{"reason": "Unauthorized"}}})
		conn.Write(context.Background(), websocket.MessageText, reply)
		select {
		case refused <- struct{}{}:
		default:
		}
		conn.Read(context.Background())
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	c.UseServer(server.URL, "")
	connected := false
	ch := c.OpenChannel("watch-party:p1", "me", func(context.Context) (string, error) { return "jwt", nil },
		ChannelHandler{Connected: func(on bool) { connected = connected || on }})
	select {
	case <-refused:
	case <-time.After(2 * time.Second):
		t.Fatal("never joined")
	}
	ch.Close()
	if connected {
		t.Error("a refused join counted as connected")
	}
}
