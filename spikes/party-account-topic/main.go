// Spike: can Peli announce a running watch party to the other profiles of the
// same Nuvio account over Nuvio's realtime websocket?
//
// It signs two password-grant sessions into the same account (A and B, standing
// in for two devices or profiles) and:
//
//  1. asks watch_party_topic_allowed about a list of candidate topics, from
//     both sessions;
//  2. creates one party, and works the party's own topic first (A joins and
//     tracks, B joins late and must see A in its initial presence_state, A
//     broadcasts and B must get it, then payload sizes);
//  3. tries the other candidate topics, private as Peli's client joins them,
//     and public when the private join is refused, recording each phx_reply.
//
// Everything it creates is undone: the party is ended and both sessions are
// signed out.
//
// The realtime frames are written by hand here (copied from
// internal/nuvio/realtime.go) rather than through its Channel, because this
// spike needs the phx_reply status and reason of a refused join verbatim.
//
// Run: set -a; source spikes/nuvio-backend/.env; set +a
//
//	go run ./spikes/party-account-topic
//
// See REPORT.md next to this file.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/k22i/Peli/internal/nuvio"
)

const (
	userAgent = "Peli/0.0.0-party-topic-spike (+https://github.com/k22i/Peli)"
	waitLimit = 10 * time.Second
	// Between sockets, so a run never looks like a burst to the server.
	gap = 300 * time.Millisecond
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "spike failed: %v\n", err)
		os.Exit(1)
	}
}

// channel is one attempt to open one topic from one session.
type channel struct {
	s      *rsession
	status string // the join's phx_reply status and reason, redacted
	ok     bool
}

func run() error {
	email, password := os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD")
	if email == "" || password == "" {
		return fmt.Errorf("set NUVIO_EMAIL and NUVIO_PASSWORD (set -a; source spikes/nuvio-backend/.env)")
	}
	base := strings.TrimRight(os.Getenv("NUVIO_URL"), "/")
	if base == "" {
		base = nuvio.DefaultURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	red := &redactor{}
	red.add(email, "<email>")
	red.add(password, "<password>")
	logf := red.printf

	logf("== backend\n%s\n\n", base)
	key, err := discoveryKey(ctx, base)
	if err != nil {
		return fmt.Errorf("discovery: %w", err)
	}
	red.add(key, "<apikey>")

	// Two sessions of one account: A and B.
	c := nuvio.New(base, "0.0.0-party-topic-spike")
	a, err := c.SignInWithPassword(ctx, email, password)
	if err != nil {
		return fmt.Errorf("sign in A: %w", err)
	}
	red.add(a.AccessToken, "<access-token-a>")
	red.add(a.RefreshToken, "<refresh-token-a>")
	red.add(a.UserID, "<user-uuid>")
	defer func() {
		if err := c.SignOut(context.Background(), a); err != nil {
			fmt.Fprintf(os.Stderr, "sign out A: %v\n", err)
			return
		}
		fmt.Print("signed out A\n")
	}()
	b, err := c.SignInWithPassword(ctx, email, password)
	if err != nil {
		return fmt.Errorf("sign in B: %w", err)
	}
	red.add(b.AccessToken, "<access-token-b>")
	red.add(b.RefreshToken, "<refresh-token-b>")
	red.add(b.UserID, "<user-uuid-b>")
	defer func() {
		if err := c.SignOut(context.Background(), b); err != nil {
			fmt.Fprintf(os.Stderr, "sign out B: %v\n", err)
			return
		}
		fmt.Print("signed out B\n")
	}()
	if a.UserID != b.UserID {
		return fmt.Errorf("the two sessions are not the same account")
	}
	logf("== sessions\nA and B are separate password grants on account %s\n\n", a.UserID)

	api := &client{base: base, key: key, red: red, http: &http.Client{Timeout: 20 * time.Second}}

	// What PostgREST's OpenAPI document says about the party functions.
	logf("== openapi\n")
	if paths, err := openapiPaths(ctx, api); err != nil {
		logf("  /rest/v1/: %v\n", err)
	} else {
		party := []string{}
		for _, p := range paths {
			if strings.Contains(p, "party") {
				party = append(party, p)
			}
		}
		logf("  %d paths, %d with \"party\" in the name\n", len(paths), len(party))
		if len(party) > 0 {
			logf("  %s\n", strings.Join(party, ", "))
		} else {
			logf("  the party functions are not in the document at all\n")
		}
	}
	logf("\n")

	// The function's own signature, from PostgREST's "no such function" hint.
	logf("== watch_party_topic_allowed's signature and edges\n")
	for _, probe := range []struct {
		note   string
		params any
	}{
		{"no arguments at all", map[string]any{}},
		{"a parameter it doesn't have", map[string]any{"p_bogus": true, "p_topic": "watch-party:x"}},
		{"p_topic null", map[string]any{"p_topic": nil}},
		{"an empty topic", map[string]any{"p_topic": ""}},
		{"a bare prefix", map[string]any{"p_topic": "watch-party:"}},
	} {
		status, body, err := api.rpc(ctx, a.AccessToken, "/rest/v1/rpc/watch_party_topic_allowed", probe.params)
		if err != nil {
			logf("  %-32s error %v\n", probe.note, err)
			continue
		}
		logf("  %-32s %d %s\n", probe.note, status, red.apply(body))
	}
	logf("\n")

	// One party, created by A, so watch-party:<id> is a real topic.
	media := nuvio.PartyMedia{
		Type: "movie", MetaID: "tt0000001", MetaType: "movie", VideoID: "tt0000001",
		Title:  "Peli party-topic spike",
		Source: &nuvio.PartySource{Filename: "peli.spike.mkv", Name: "1080p"},
	}
	host := nuvio.PartyIdentity{DeviceID: "peli-spike-host-" + randomHex(4), DisplayName: "Peli spike host"}
	created, err := c.PartyCreate(ctx, a, host, media)
	if err != nil || created.Error != "" || created.Party == nil {
		return fmt.Errorf("create party: %+v, %w", created, err)
	}
	party := created.Party
	red.add(party.ID, "<party-id>")
	red.add(party.Code, "<code>")
	logf("== party\nid %s, code %s (%d characters), %d seats, host member <member-id>\n\n",
		party.ID, party.Code, len(party.Code), party.MaxMembers)
	ended := false
	defer func() {
		if ended {
			return
		}
		out, err := c.PartyEnd(context.Background(), a, party.ID, host.DeviceID)
		if err != nil || out.Error != "" {
			fmt.Fprintf(os.Stderr, "end party in cleanup: %+v, %v\n", out, err)
			return
		}
		fmt.Print("ended the party in the cleanup\n")
	}()

	partyTopic := "watch-party:" + party.ID
	unknownParty := "watch-party:" + randomUUID()
	topics := []struct{ note, name string }{
		{"a real party", partyTopic},
		{"a party that doesn't exist", unknownParty},
		{"the account", "account:" + a.UserID},
		{"the user", "user:" + a.UserID},
		{"Peli's own namespace", "peli:" + a.UserID},
		{"a profile", "profile:" + a.UserID + ":1"},
		{"account + parties", "account:" + a.UserID + ":parties"},
		{"parties + account", "parties:" + a.UserID},
		{"watch-parties + account", "watch-parties:" + a.UserID},
		{"peli + parties", "peli:parties:" + a.UserID},
	}

	// 1. What the function says about each candidate, from both sessions.
	logf("== watch_party_topic_allowed\nasked from A and from B, as {\"p_topic\": \"<topic>\"}\n")
	for _, t := range topics {
		answers := make([]string, 2)
		for i, s := range []nuvio.Session{a, b} {
			status, body, err := api.rpc(ctx, s.AccessToken, "/rest/v1/rpc/watch_party_topic_allowed",
				map[string]any{"p_topic": t.name})
			if err != nil {
				answers[i] = "error " + err.Error()
				continue
			}
			answers[i] = fmt.Sprintf("%d %s", status, oneLine(body, 40))
		}
		logf("  %-26s %-40s A %-12s B %s\n", t.note, t.name, answers[0], answers[1])
	}
	logf("\n")

	// 2. The party's own topic, worked before anything else opens a socket:
	// A joins and tracks, B joins late and must see A in presence_state, A
	// broadcasts, then payload sizes.
	logf("== the party's own topic: %s\n", partyTopic)
	chA := joinAs(ctx, api, a.AccessToken, partyTopic, "peli-spike-a", true)
	if chA.s != nil {
		defer chA.s.close()
	}
	logf("  A (the host, member <member-id>) private join: %s\n", chA.status)
	time.Sleep(gap)
	alive := func(s *rsession) string {
		if s == nil {
			return "no socket"
		}
		if err := s.heartbeat(); err != nil {
			return "dead: " + oneLine(api.red.apply(err.Error()), 90)
		}
		if _, ok := s.wait(func(f frame) bool {
			return f.Topic == "phoenix" && f.Event == "phx_reply"
		}, 5*time.Second); ok {
			return "alive"
		}
		return "no heartbeat reply"
	}
	logf("  socket alive after the join: %s\n", alive(chA.s))

	marker := "m-" + randomHex(3)
	presence := map[string]any{"member_id": created.MemberID, "status": "live", "code": "TEST", "marker": marker, "at": time.Now().UnixMilli()}
	if chA.ok {
		logf("  A track: %v\n", chA.s.track(presence))
		logf("  A broadcast: %v\n", chA.s.broadcast("party_live", map[string]any{"code": "TEST", "marker": marker}))
		if got, seen := chA.s.wait(func(f frame) bool { return strings.Contains(string(f.Payload), marker) }, time.Second); seen {
			logf("  A got its own back (self:false should stop this): %s\n", oneLine(string(got.Payload), 200))
		} else {
			logf("  A got its own back: no\n")
		}
	}

	time.Sleep(gap)
	chB := joinAs(ctx, api, b.AccessToken, partyTopic, "peli-spike-b", true)
	if chB.s != nil {
		defer chB.s.close()
	}
	logf("  B (never called watch_party_join, no seat) private join: %s\n", chB.status)
	if chB.ok {
		if got, ok := chB.s.wait(func(f frame) bool { return f.Event == "presence_state" }, waitLimit); ok {
			logf("  B's initial presence_state: %s\n", oneLine(string(got.Payload), 400))
		} else {
			logf("  B's initial presence_state: none within %v\n", waitLimit)
		}
		late := "m-" + randomHex(3)
		logf("  B track: %v\n", chB.s.track(map[string]any{"member_id": "b-not-a-member", "status": "loaded", "marker": late}))
		if chA.ok {
			if got, ok := chA.s.wait(func(f frame) bool {
				return f.Event == "presence_diff" && strings.Contains(string(f.Payload), late)
			}, waitLimit); ok {
				logf("  A sees B's presence (presence_diff): %s\n", oneLine(string(got.Payload), 300))
			} else {
				logf("  A sees B's presence: no\n")
			}
		}
		if chA.ok {
			next := "m-" + randomHex(3)
			if err := chA.s.broadcast("party_live", map[string]any{"code": "TEST", "marker": next}); err != nil {
				logf("  A broadcasts again: %v\n", err)
			}
			if got, ok := chB.s.wait(func(f frame) bool {
				return f.Event == "broadcast" && strings.Contains(string(f.Payload), next)
			}, waitLimit); ok {
				logf("  B receives A's broadcast: %s\n", oneLine(string(got.Payload), 200))
			} else {
				logf("  B receives A's broadcast: no (%s)\n", alive(chB.s))
			}
			for _, size := range []int{8 << 10, 100 << 10} {
				sizeMarker := "size-" + randomHex(3)
				body := map[string]any{"code": "TEST", "marker": sizeMarker, "padding": strings.Repeat("x", size)}
				if err := chA.s.broadcast("party_live", body); err != nil {
					logf("  %d bytes: send failed: %v\n", size, err)
					continue
				}
				if got, ok := chB.s.wait(func(f frame) bool {
					return f.Event == "broadcast" && strings.Contains(string(f.Payload), sizeMarker)
				}, waitLimit); ok {
					logf("  %d bytes: B got it (%d bytes of payload)\n", size, len(got.Payload))
				} else {
					logf("  %d bytes: B got it: no\n", size)
				}
			}
		}
	}
	logf("\n")

	// 3. The other candidates: private as Peli joins, public as the contrast.
	logf("== joins\nsocket topic = realtime: + the topic above, presence key peli-spike-a / peli-spike-b\n")
	for _, t := range topics {
		if t.name == partyTopic {
			continue
		}
		ca := joinAs(ctx, api, a.AccessToken, t.name, "peli-spike-a", true)
		if ca.s != nil {
			defer ca.s.close()
		}
		time.Sleep(gap)
		cb := joinAs(ctx, api, b.AccessToken, t.name, "peli-spike-b", true)
		if cb.s != nil {
			defer cb.s.close()
		}
		logf("  %-40s\n    A private: %s\n", t.name, ca.status)
		if cb.status != "" {
			logf("    B private: %s\n", cb.status)
		}
		if !ca.ok {
			time.Sleep(gap)
			pub := joinAs(ctx, api, a.AccessToken, t.name, "peli-spike-a", false)
			if pub.s != nil {
				defer pub.s.close()
			}
			logf("    A public (private:false, the contrast): %s\n", pub.status)
		}
	}
	logf("\n")

	// 4. Logical vs socket spelling of the party topic, since the function
	// answers on the unprefixed name and the socket needs the prefix.
	logf("== the two spellings of the party topic\n")
	for _, spelling := range []string{partyTopic, "realtime:" + partyTopic} {
		_, body, err := api.rpc(ctx, a.AccessToken, "/rest/v1/rpc/watch_party_topic_allowed",
			map[string]any{"p_topic": spelling})
		logf("  watch_party_topic_allowed(%-40s) = %s, %v\n", spelling, oneLine(body, 40), err)
	}
	logf("  joining the unprefixed socket topic (no realtime: prefix):\n")
	raw, err := openSession(ctx, api.base, api.key, a.AccessToken, partyTopic, "peli-spike-a-raw", true)
	if err != nil {
		logf("    dial: %v\n", api.red.apply(err.Error()))
	} else {
		defer raw.close()
		st, resp, ok := raw.joinStatus(waitLimit)
		logf("    phx_reply %s %s (got a reply: %v)\n", st, api.red.apply(resp), ok)
	}
	logf("\n")

	// 5. The frames themselves.
	logf("== frames\n%s\n", "the join frame sent, token redacted")
	logf("  {\"topic\":\"realtime:<topic>\",\"event\":\"phx_join\",\"payload\":{\"config\":{\"broadcast\":{\"ack\":false,\"self\":false},\"presence\":{\"key\":\"peli-spike-a\",\"enabled\":true},\"postgres_changes\":[],\"private\":true},\"access_token\":\"<token>\"},\"ref\":\"1\",\"join_ref\":\"1\"}\n")
	logf("  on %s:\n", partyTopic)
	dumpFrames(red, chA.s, "A")
	dumpFrames(red, chB.s, "B")
	logf("\n")

	// Undo.
	out, err := c.PartyEnd(ctx, a, party.ID, host.DeviceID)
	if err != nil || out.Error != "" {
		return fmt.Errorf("end party: %+v, %w", out, err)
	}
	ended = out.OK
	logf("== cleanup\nparty ended: ok=%v, error %q\n", out.OK, out.Error)
	return nil
}

// --- the REST side ---------------------------------------------------------

type client struct {
	base string
	key  string
	http *http.Client
	red  *redactor
}

// rpc calls a PostgREST function with this session's token and returns the
// status and the body as it came.
func (a *client) rpc(ctx context.Context, token, path string, params any) (int, string, error) {
	body, err := json.Marshal(params)
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Apikey", a.key)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := a.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, strings.TrimSpace(string(data)), nil
}

// get reads a URL with the key and no session.
func (a *client) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Apikey", a.key)
	req.Header.Set("Authorization", "Bearer "+a.key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if res.StatusCode >= 300 {
		return data, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return data, err
}

func discoveryKey(ctx context.Context, base string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/.well-known/nuvio", nil)
	req.Header.Set("User-Agent", userAgent)
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var doc struct {
		Service        string `json:"service"`
		PublishableKey string `json:"publishable_key"`
	}
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return "", err
	}
	if doc.Service != "nuvio" || doc.PublishableKey == "" {
		return "", fmt.Errorf("not a Nuvio backend: %q", doc.Service)
	}
	return doc.PublishableKey, nil
}

// openapiPaths lists what PostgREST's OpenAPI document offers.
func openapiPaths(ctx context.Context, a *client) ([]string, error) {
	data, err := a.get(ctx, "/rest/v1/")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(doc.Paths))
	for key := range doc.Paths {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

// --- the realtime side -----------------------------------------------------

// frame is one Phoenix frame, as it arrived.
type frame struct {
	At      time.Time
	Topic   string          `json:"topic"`
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
	Ref     string          `json:"ref"`
}

// rsession is one channel on one socket, with the join frame written by hand
// (the same one internal/nuvio/realtime.go sends) so its answer can be read
// verbatim.
type rsession struct {
	name    string
	topic   string // the socket topic, e.g. "realtime:account:<uuid>"
	key     string
	conn    *websocket.Conn
	joinRef string

	mu      sync.Mutex
	ref     int
	frames  []frame
	more    chan struct{}
	dead    chan struct{}
	readErr error
}

// joinAs opens topic (the logical name) from a session's token and reports the
// join's status and reason.
func joinAs(ctx context.Context, api *client, token, name, presenceKey string, private bool) channel {
	s, err := openSession(ctx, api.base, api.key, token, "realtime:"+name, presenceKey, private)
	if err != nil {
		return channel{status: "dial: " + oneLine(api.red.apply(err.Error()), 200)}
	}
	status, response, ok := s.joinStatus(waitLimit)
	if !ok {
		s.close()
		return channel{status: fmt.Sprintf("no usable reply: %s %s", status, oneLine(api.red.apply(response), 120))}
	}
	text := fmt.Sprintf("phx_reply %s %s", status, api.red.apply(response))
	if status != "ok" {
		s.close()
		return channel{status: text}
	}
	return channel{s: s, status: text, ok: true}
}

func openSession(ctx context.Context, base, key, token, socketTopic, presenceKey string, private bool) (*rsession, error) {
	endpoint, err := wsURL(base, key)
	if err != nil {
		return nil, err
	}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPHeader: http.Header{"User-Agent": {userAgent}},
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	s := &rsession{
		name: socketTopic, topic: socketTopic, key: presenceKey, conn: conn,
		joinRef: "1", ref: 1, more: make(chan struct{}, 1), dead: make(chan struct{}),
	}
	// The join frame exactly as realtime.go builds it: ref == join_ref,
	// private, with the session's access token.
	join := map[string]any{
		"topic": socketTopic,
		"event": "phx_join",
		"payload": map[string]any{
			"config": map[string]any{
				"broadcast":        map[string]any{"ack": false, "self": false},
				"presence":         map[string]any{"key": presenceKey, "enabled": true},
				"postgres_changes": []any{},
				"private":          private,
			},
			"access_token": token,
		},
		"ref":      s.joinRef,
		"join_ref": s.joinRef,
	}
	if err := s.write(join); err != nil {
		conn.CloseNow()
		return nil, err
	}
	go s.read(ctx)
	return s, nil
}

func wsURL(base, key string) (string, error) {
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
	u.RawQuery = url.Values{"nuvio_realtime": {"1"}, "apikey": {key}, "vsn": {"1.0.0"}}.Encode()
	return u.String(), nil
}

func (s *rsession) read(ctx context.Context) {
	defer close(s.dead)
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			s.mu.Lock()
			s.readErr = err
			s.mu.Unlock()
			s.notify()
			return
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		f.At = time.Now()
		s.mu.Lock()
		s.frames = append(s.frames, f)
		s.mu.Unlock()
		s.notify()
	}
}

func (s *rsession) notify() {
	select {
	case s.more <- struct{}{}:
	default:
	}
}

func (s *rsession) write(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageText, data)
}

func (s *rsession) push(event string, payload any) error {
	s.mu.Lock()
	s.ref++
	ref := strconv.Itoa(s.ref)
	s.mu.Unlock()
	return s.write(map[string]any{
		"topic": s.topic, "event": event, "payload": payload,
		"ref": ref, "join_ref": s.joinRef,
	})
}

func (s *rsession) broadcast(event string, payload any) error {
	return s.push("broadcast", map[string]any{"type": "broadcast", "event": event, "payload": payload})
}

func (s *rsession) track(payload any) error {
	return s.push("presence", map[string]any{"type": "presence", "event": "track", "payload": payload})
}

// heartbeat sends Phoenix's socket heartbeat and returns the write error.
func (s *rsession) heartbeat() error {
	s.mu.Lock()
	s.ref++
	ref := strconv.Itoa(s.ref)
	s.mu.Unlock()
	return s.write(map[string]any{"topic": "phoenix", "event": "heartbeat", "payload": map[string]any{}, "ref": ref})
}

func (s *rsession) close() {
	if s == nil || s.conn == nil {
		return
	}
	s.conn.CloseNow()
	<-s.dead
}

// joinStatus waits for the reply to the join frame: its status and response as
// they came.
func (s *rsession) joinStatus(limit time.Duration) (status, response string, ok bool) {
	f, got := s.wait(func(f frame) bool { return f.Event == "phx_reply" && f.Ref == s.joinRef }, limit)
	if !got {
		for _, e := range s.snapshot() {
			if e.Event == "phx_error" || e.Event == "phx_close" || e.Event == "system" {
				return e.Event, string(e.Payload), false
			}
		}
		return "no reply", "", false
	}
	var reply struct {
		Status   string          `json:"status"`
		Response json.RawMessage `json:"response"`
	}
	json.Unmarshal(f.Payload, &reply)
	return reply.Status, string(reply.Response), true
}

// wait returns the first frame matching, waiting up to limit.
func (s *rsession) wait(match func(frame) bool, limit time.Duration) (frame, bool) {
	if f, ok := s.first(match); ok {
		return f, true
	}
	deadline := time.After(limit)
	for {
		select {
		case <-s.more:
			if f, ok := s.first(match); ok {
				return f, true
			}
		case <-s.dead:
			if f, ok := s.first(match); ok {
				return f, true
			}
			return frame{}, false
		case <-deadline:
			return frame{}, false
		}
	}
}

func (s *rsession) first(match func(frame) bool) (frame, bool) {
	for _, f := range s.snapshot() {
		if match(f) {
			return f, true
		}
	}
	return frame{}, false
}

func (s *rsession) snapshot() []frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]frame(nil), s.frames...)
}

// dumpFrames prints every frame one session received, redacted.
func dumpFrames(red *redactor, s *rsession, label string) {
	if s == nil {
		red.printf("    %s <- no live socket\n", label)
		return
	}
	frames := s.snapshot()
	if len(frames) == 0 {
		red.printf("    %s <- nothing\n", label)
	}
	for _, f := range frames {
		red.printf("    %s <- event %q ref %s payload %s\n", label, f.Event, f.Ref, oneLine(string(f.Payload), 400))
	}
	s.mu.Lock()
	err := s.readErr
	s.mu.Unlock()
	if err != nil {
		red.printf("    %s <- socket ended: %s\n", label, oneLine(red.apply(err.Error()), 200))
	}
}

// --- small helpers ---------------------------------------------------------

type redactor struct{ pairs [][2]string }

func (r *redactor) add(secret, name string) {
	if secret == "" || secret == name {
		return
	}
	r.pairs = append(r.pairs, [2]string{secret, name})
	sort.SliceStable(r.pairs, func(i, j int) bool { return len(r.pairs[i][0]) > len(r.pairs[j][0]) })
}

var (
	jwtish  = regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}`)
	uuidish = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
)

func (r *redactor) apply(s string) string {
	for _, p := range r.pairs {
		s = strings.ReplaceAll(s, p[0], p[1])
	}
	s = jwtish.ReplaceAllString(s, "<token>")
	s = uuidish.ReplaceAllString(s, "<uuid>")
	return s
}

func (r *redactor) printf(format string, a ...any) {
	fmt.Print(r.apply(fmt.Sprintf(format, a...)))
}

func oneLine(s string, max int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randomUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
