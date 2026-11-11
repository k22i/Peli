package nuvio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestLiveParty checks watch parties (ADR-0051) against api.nuvio.tv, the
// only backend that has them: two devices of one account start and join a
// party, see each other's presence and broadcasts on its channel, chat, and
// try every host action; then the party is ended and the session signed out,
// so nothing is left behind. Every answer is checked against liveOnly's type.
// It runs only with SINAG_NUVIO_LIVE_WRITES=1 and NUVIO_EMAIL and
// NUVIO_PASSWORD.
func TestLiveParty(t *testing.T) {
	if os.Getenv("SINAG_REALTIME_DEBUG") == "1" {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}
	if os.Getenv("SINAG_NUVIO_LIVE_WRITES") != "1" {
		t.Skip("set SINAG_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD to start a party on a live backend")
	}
	url := cmpOr(os.Getenv("NUVIO_URL"), DefaultURL)
	c := New(url, "0.0.0-live-test")
	shapes := &shapeCheck{next: http.DefaultTransport, t: t, seen: map[string]bool{}}
	c.http.Transport = shapes
	ctx := t.Context()

	enabled, err := c.PartiesEnabled(ctx)
	if err != nil || !enabled {
		t.Fatalf("parties enabled = %v, %v", enabled, err)
	}
	s, err := c.SignInWithPassword(ctx, os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil && !errors.Is(err, ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	token := func(context.Context) (string, error) { return s.AccessToken, nil }

	sentAt := time.Now()
	server, err := c.PartyClock(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if skew := time.Duration(server-time.Now().UnixMilli()) * time.Millisecond; skew.Abs() > time.Minute {
		t.Errorf("server clock is %v off", skew)
	}
	t.Logf("clock: %v round trip", time.Since(sentAt).Round(time.Millisecond))

	season, episode := 1, 1
	media := PartyMedia{
		Type: "series", MetaID: "tt0000000", MetaType: "series", VideoID: "tt0000000:1:1",
		Season: &season, Episode: &episode, Title: "Sinag live test", EpisodeTitle: "Pilot",
		Source: &PartySource{Filename: "sinag.live.test.mkv", Name: "1080p"},
	}
	host := PartyIdentity{DeviceID: "sinag-live-test-host-" + randomHex(4), DisplayName: "Sinag test host"}
	guest := PartyIdentity{DeviceID: "sinag-live-test-guest-" + randomHex(4), DisplayName: "Sinag test guest", AvatarColor: "#33B5E0"}

	created, err := c.PartyCreate(ctx, s, host, media)
	if err != nil || created.Error != "" || created.Party == nil {
		t.Fatalf("create: %+v, %v", created, err)
	}
	party := created.Party
	ended := false
	t.Cleanup(func() {
		if !ended {
			c.PartyEnd(context.Background(), s, party.ID, host.DeviceID)
		}
	})
	if party.Media.Key() != media.Key() || created.MemberID == "" || party.HostMemberID != created.MemberID {
		t.Errorf("created party: media %q, member %q, host %q", party.Media.Key(), created.MemberID, party.HostMemberID)
	}
	t.Logf("party: code of %d characters, %d seats", len(party.Code), party.MaxMembers)

	preview, err := c.PartyPreview(ctx, s, party.Code)
	if err != nil || preview.Error != "" || preview.Media == nil || preview.Members != 1 {
		t.Errorf("preview: %+v, %v", preview, err)
	}
	if missing, err := c.PartyPreview(ctx, s, "ZZZZZZ"); err != nil || missing.Error != PartyNotFound {
		t.Errorf("preview of no party: %+v, %v", missing, err)
	}

	joined, err := c.PartyJoin(ctx, s, party.Code, guest)
	if err != nil || joined.Error != "" || joined.MemberID == "" || len(joined.Members) != 2 {
		t.Fatalf("join: %+v, %v", joined, err)
	}

	hostEvents, guestEvents := newInbox(), newInbox()
	hostCh := c.OpenChannel("watch-party:"+party.ID, created.MemberID, token, hostEvents.handler())
	defer hostCh.Close()
	guestCh := c.OpenChannel("watch-party:"+party.ID, joined.MemberID, token, guestEvents.handler())
	defer guestCh.Close()
	hostEvents.wait(t, "host joins the channel", func(e event) bool { return e.kind == "connected" })
	guestEvents.wait(t, "guest joins the channel", func(e event) bool { return e.kind == "connected" })

	if err := guestCh.Track(map[string]any{"member_id": joined.MemberID, "status": "loading", "media_key": media.Key()}); err != nil {
		t.Fatal(err)
	}
	hostEvents.wait(t, "host sees the guest's presence", func(e event) bool {
		return e.kind == "join" && e.name == joined.MemberID && strings.Contains(string(e.payload), `"loading"`)
	})

	playback := PartyPlayback{Seq: 1, MemberID: created.MemberID, PositionMs: 1000, Rate: 1, At: server, MediaKey: media.Key()}
	if err := hostCh.Send("state", playback); err != nil {
		t.Fatal(err)
	}
	got := guestEvents.wait(t, "guest gets the host's state", func(e event) bool { return e.kind == "broadcast" && e.name == "state" })
	var received PartyPlayback
	if json.Unmarshal(got.payload, &received) != nil || received != playback {
		t.Errorf("state: %s", got.payload)
	}

	// Update answers only ok; the next heartbeat has what it kept.
	updated, err := c.PartyUpdate(ctx, s, party.ID, host.DeviceID, nil, &playback)
	if err != nil || updated.Error != "" || !updated.OK {
		t.Errorf("update: %+v, %v", updated, err)
	}
	beat, err := c.PartyHeartbeat(ctx, s, party.ID, guest.DeviceID)
	if err != nil || beat.Error != "" || beat.MemberID != joined.MemberID ||
		beat.Party == nil || beat.Party.Playback == nil || beat.Party.Playback.PositionMs != 1000 {
		t.Errorf("heartbeat: %+v, %v", beat, err)
	}

	// The host moving on to the next episode is broadcast as media.
	next := media
	episode2 := 2
	next.Episode, next.VideoID, next.EpisodeTitle = &episode2, "tt0000000:1:2", "Second"
	nextPlayback := PartyPlayback{Seq: 2, MemberID: created.MemberID, Rate: 1, At: server, MediaKey: next.Key()}
	if moved, err := c.PartyUpdate(ctx, s, party.ID, host.DeviceID, &next, &nextPlayback); err != nil || moved.Error != "" {
		t.Errorf("update media: %+v, %v", moved, err)
	}
	moved := guestEvents.wait(t, "guest hears the new media", func(e event) bool { return e.kind == "broadcast" && e.name == "media" })
	var change struct {
		Media    PartyMedia     `json:"media"`
		Playback *PartyPlayback `json:"playback"`
	}
	if json.Unmarshal(moved.payload, &change) != nil || change.Media.Key() != next.Key() || change.Playback == nil {
		t.Errorf("media: %s", moved.payload)
	}
	if refused, err := c.PartyUpdate(ctx, s, party.ID, guest.DeviceID, &media, nil); err != nil || refused.Error == "" {
		t.Errorf("a guest changed the media: %+v, %v", refused, err)
	}

	only, err := c.PartySetHostOnly(ctx, s, party.ID, host.DeviceID, true)
	if err != nil || only.Error != "" || only.Party == nil || !only.Party.HostOnly {
		t.Errorf("host only: %+v, %v", only, err)
	}
	guestEvents.wait(t, "guest hears host-only control", func(e event) bool { return e.kind == "broadcast" && e.name == "control" })
	if refused, err := c.PartySetHostOnly(ctx, s, party.ID, guest.DeviceID, false); err == nil && refused.Error == "" {
		t.Errorf("a guest set host-only: %+v", refused)
	} else {
		t.Logf("guest setting host-only: %q, %v", refused.Error, err)
	}

	sent, err := c.PartySendMessage(ctx, s, party.ID, guest.DeviceID, "hello from Sinag's live test", "sinaglivetest"+randomHex(4))
	if err != nil || sent.Error != "" || sent.Message == nil {
		t.Fatalf("send: %+v, %v", sent, err)
	}
	hostEvents.wait(t, "host gets the chat message", func(e event) bool { return e.kind == "broadcast" && e.name == "chat" })
	history, err := c.PartyMessages(ctx, s, party.ID, host.DeviceID, 0)
	if err != nil || history.Error != "" || len(history.Messages) != 1 || history.Messages[0].Mine {
		t.Errorf("messages: %+v, %v", history, err)
	}
	if after, err := c.PartyMessages(ctx, s, party.ID, host.DeviceID, sent.Message.ID); err != nil || len(after.Messages) != 0 {
		t.Errorf("messages after the last: %+v, %v", after, err)
	}

	removed, err := c.PartyRemoveMember(ctx, s, party.ID, host.DeviceID, joined.MemberID)
	if err != nil || removed.Error != "" || len(removed.Members) != 1 {
		t.Errorf("remove: %+v, %v", removed, err)
	}
	left := hostEvents.wait(t, "host hears the guest leave", func(e event) bool { return e.kind == "broadcast" && e.name == "member_left" })
	t.Logf("member_left: %s", left.payload)
	if again, err := c.PartyJoin(ctx, s, party.Code, guest); err != nil || again.Error != PartyRemoved {
		t.Errorf("join after removal: %q, %v", again.Error, err)
	}
	if beat, err := c.PartyHeartbeat(ctx, s, party.ID, guest.DeviceID); err != nil || beat.Error == "" {
		t.Errorf("removed guest's heartbeat: %+v, %v", beat, err)
	} else {
		t.Logf("removed guest's heartbeat: %q", beat.Error)
	}
	if bye, err := c.PartyLeave(ctx, s, party.ID, guest.DeviceID); err != nil {
		t.Errorf("leave: %+v, %v", bye, err)
	} else {
		t.Logf("removed guest leaving: %q", bye.Error)
	}
	end, err := c.PartyEnd(ctx, s, party.ID, host.DeviceID)
	ended = err == nil && end.Error == ""
	if !ended || !end.OK {
		t.Errorf("end: %+v, %v", end, err)
	}
	if after, err := c.PartyHeartbeat(ctx, s, party.ID, host.DeviceID); err != nil || after.Error != PartyEnded {
		t.Errorf("heartbeat after the end: %q, %v", after.Error, err)
	}
	if !t.Failed() {
		for path := range liveOnly {
			if !shapes.seen[path] {
				t.Errorf("TestLiveParty didn't call %s", path)
			}
		}
	}
}

// shapeCheck checks every 2xx answer against liveOnly's type.
type shapeCheck struct {
	next http.RoundTripper
	t    *testing.T
	mu   sync.Mutex
	seen map[string]bool
}

func (s *shapeCheck) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := s.next.RoundTrip(req)
	// The websocket's upgrade (101) keeps its body: it is the connection.
	if err != nil || res.StatusCode < 200 || res.StatusCode >= 300 {
		return res, err
	}
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	res.Body = io.NopCloser(bytes.NewReader(data))
	a, ok := liveOnly[req.URL.Path]
	if !ok || err != nil {
		return res, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen[req.URL.Path] = true
	if a.row == nil {
		return res, nil
	}
	problems, unread := shapeErrors(data, a)
	for _, p := range problems {
		// Answers that refuse carry only "error".
		if !strings.Contains(string(data), `"error"`) {
			s.t.Errorf("%s: %s", req.URL.Path, p)
		}
	}
	if len(unread) > 0 {
		s.t.Logf("%s: unread fields %q", req.URL.Path, unread)
	}
	return res, nil
}

type event struct {
	kind, name string
	payload    json.RawMessage
}

// inbox collects a channel's events for wait.
type inbox struct {
	mu     sync.Mutex
	events []event
	more   chan struct{}
}

func newInbox() *inbox { return &inbox{more: make(chan struct{}, 1)} }

func (in *inbox) add(e event) {
	in.mu.Lock()
	in.events = append(in.events, e)
	in.mu.Unlock()
	select {
	case in.more <- struct{}{}:
	default:
	}
}

func (in *inbox) handler() ChannelHandler {
	return ChannelHandler{
		Broadcast: func(name string, payload json.RawMessage) { in.add(event{"broadcast", name, payload}) },
		Presence: func(joins, leaves map[string]json.RawMessage) {
			for k, v := range joins {
				in.add(event{"join", k, v})
			}
			for k, v := range leaves {
				in.add(event{"leave", k, v})
			}
		},
		Connected: func(on bool) {
			if on {
				in.add(event{kind: "connected"})
			} else {
				in.add(event{kind: "disconnected"})
			}
		},
	}
}

// wait returns the first event that matches, failing after 15 s.
func (in *inbox) wait(t *testing.T, what string, match func(event) bool) event {
	t.Helper()
	deadline := time.After(15 * time.Second)
	next := 0
	for {
		in.mu.Lock()
		for ; next < len(in.events); next++ {
			if match(in.events[next]) {
				e := in.events[next]
				in.mu.Unlock()
				return e
			}
		}
		in.mu.Unlock()
		select {
		case <-in.more:
		case <-deadline:
			in.mu.Lock()
			kinds := []string{}
			for _, e := range in.events {
				kinds = append(kinds, e.kind+":"+e.name)
			}
			in.mu.Unlock()
			t.Fatalf("%s: not within 15 s (got %v)", what, kinds)
			return event{}
		}
	}
}
