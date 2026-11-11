package party

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/player"
)

// fakeAPI is Nuvio's side of a party, as a test sets it up.
type fakeAPI struct {
	mu       sync.Mutex
	answer   backend.PartySnapshot
	calls    []string
	updates  []backend.PartyPlayback
	media    []backend.PartyMedia
	channels []*fakeChannel
	clockMs  func() int64
	sendErr  error
}

func (f *fakeAPI) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *fakeAPI) called(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.calls, call)
}

func (f *fakeAPI) Enabled(context.Context) (bool, error) { return true, nil }
func (f *fakeAPI) Create(_ context.Context, _ backend.PartyIdentity, media backend.PartyMedia) (backend.PartySnapshot, error) {
	f.record("create")
	f.mu.Lock()
	defer f.mu.Unlock()
	snap := f.answer
	info := *snap.Party
	info.Media = media
	snap.Party = &info
	return snap, nil
}
func (f *fakeAPI) Join(context.Context, string, backend.PartyIdentity) (backend.PartySnapshot, error) {
	f.record("join")
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.answer, nil
}
func (f *fakeAPI) Preview(context.Context, string) (backend.PartyPreview, error) {
	return backend.PartyPreview{}, nil
}
func (f *fakeAPI) Heartbeat(context.Context, string, string) (backend.PartySnapshot, error) {
	f.record("heartbeat")
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.answer, nil
}
func (f *fakeAPI) Update(_ context.Context, _, _ string, media *backend.PartyMedia, playback *backend.PartyPlayback) (backend.PartySnapshot, error) {
	f.record("update")
	f.mu.Lock()
	defer f.mu.Unlock()
	if playback != nil {
		f.updates = append(f.updates, *playback)
	}
	if media != nil {
		f.media = append(f.media, *media)
	}
	return backend.PartySnapshot{OK: true}, nil
}
func (f *fakeAPI) Leave(context.Context, string, string) (backend.PartySnapshot, error) {
	f.record("leave")
	return backend.PartySnapshot{OK: true}, nil
}
func (f *fakeAPI) End(context.Context, string, string) (backend.PartySnapshot, error) {
	f.record("end")
	return backend.PartySnapshot{OK: true}, nil
}
func (f *fakeAPI) SetHostOnly(_ context.Context, _, _ string, on bool) (backend.PartySnapshot, error) {
	f.record("host_only")
	f.mu.Lock()
	defer f.mu.Unlock()
	info := *f.answer.Party
	info.HostOnly = on
	snap := f.answer
	snap.Party = &info
	return snap, nil
}
func (f *fakeAPI) RemoveMember(context.Context, string, string, string) (backend.PartySnapshot, error) {
	f.record("remove")
	return f.answer, nil
}
func (f *fakeAPI) SendMessage(_ context.Context, _, _, body, clientID string) (backend.PartyMessageSent, error) {
	f.record("send")
	if f.sendErr != nil {
		return backend.PartyMessageSent{}, f.sendErr
	}
	return backend.PartyMessageSent{Message: &backend.PartyMessage{
		ID: 10, MemberID: f.answer.MemberID, Name: "Me", Body: body, ClientID: clientID, Mine: true,
	}}, nil
}
func (f *fakeAPI) Messages(context.Context, string, string, int64) (backend.PartyMessages, error) {
	return backend.PartyMessages{Messages: []backend.PartyMessage{}}, nil
}
func (f *fakeAPI) Clock(context.Context) (int64, error) { return f.clockMs(), nil }
func (f *fakeAPI) Open(_, _ string, handler backend.ChannelHandler) backend.Channel {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := &fakeChannel{handler: handler}
	f.channels = append(f.channels, ch)
	return ch
}

func (f *fakeAPI) channel(t *testing.T) *fakeChannel {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.channels) == 0 {
		t.Fatal("no channel was opened")
	}
	return f.channels[len(f.channels)-1]
}

type frame struct {
	event   string
	payload json.RawMessage
}

type fakeChannel struct {
	handler backend.ChannelHandler
	mu      sync.Mutex
	sent    []frame
	tracked []json.RawMessage
}

func (c *fakeChannel) Send(event string, payload any) error {
	data, _ := json.Marshal(payload)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, frame{event, data})
	return nil
}
func (c *fakeChannel) Track(payload any) error {
	data, _ := json.Marshal(payload)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tracked = append(c.tracked, data)
	return nil
}
func (c *fakeChannel) Close() {}

// broadcast delivers a message from another member.
func (c *fakeChannel) broadcast(event string, payload any) {
	data, _ := json.Marshal(payload)
	c.handler.Broadcast(event, data)
}

// lastSent waits for the newest frame of event.
func (c *fakeChannel) lastSent(t *testing.T, event string) json.RawMessage {
	t.Helper()
	var found json.RawMessage
	eventually(t, "a "+event+" frame", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for i := len(c.sent) - 1; i >= 0; i-- {
			if c.sent[i].event == event {
				found = c.sent[i].payload
				return true
			}
		}
		return false
	})
	return found
}

// stateWith waits for a state frame that matches.
func (c *fakeChannel) stateWith(t *testing.T, what string, match func(backend.PartyPlayback) bool) backend.PartyPlayback {
	t.Helper()
	var found backend.PartyPlayback
	eventually(t, what, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for i := len(c.sent) - 1; i >= 0; i-- {
			var p backend.PartyPlayback
			if c.sent[i].event == "state" && json.Unmarshal(c.sent[i].payload, &p) == nil && match(p) {
				found = p
				return true
			}
		}
		return false
	})
	return found
}

func (c *fakeChannel) count(event string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, f := range c.sent {
		if f.event == event {
			n++
		}
	}
	return n
}

// fakePlayer is mpv, as far as the party sees it.
type fakePlayer struct {
	mu    sync.Mutex
	st    player.State
	calls []string
}

func (p *fakePlayer) Snapshot() player.State {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.st
}
func (p *fakePlayer) SetPaused(paused bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st.Paused = paused
	p.calls = append(p.calls, map[bool]string{true: "pause", false: "play"}[paused])
	return nil
}
func (p *fakePlayer) Seek(position float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st.Position = position
	p.calls = append(p.calls, "seek")
	return nil
}
func (p *fakePlayer) SetSpeed(speed float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st.Speed = speed
	p.calls = append(p.calls, "speed")
	return nil
}
func (p *fakePlayer) set(change func(*player.State)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	change(&p.st)
}

// rig is a service in a party as the host or a guest, on a fake clock.
type rig struct {
	s       *Service
	api     *fakeAPI
	player  *fakePlayer
	nowMu   sync.Mutex
	now     time.Time
	notices chan Notice
	me      Me
}

var episode = func() Media {
	season, number := 1, 3
	return Media{Type: "series", ID: "tt123", VideoID: "tt123:1:3", Season: &season, Episode: &number, Title: "A show"}
}()

func newRig(t *testing.T, host bool) *rig {
	t.Helper()
	r := &rig{now: time.Unix(1_800_000_000, 0), notices: make(chan Notice, 32), player: &fakePlayer{}}
	index := 1
	r.me = Me{ProfileID: 1, Linked: true, Identity: backend.PartyIdentity{DeviceID: "dev", DisplayName: "Me", ProfileIndex: &index}}
	hostID := "other"
	if host {
		hostID = "me"
	}
	r.api = &fakeAPI{clockMs: func() int64 { return r.time().UnixMilli() }, answer: backend.PartySnapshot{
		MemberID: "me", ServerTimeMs: r.now.UnixMilli(),
		Members: []backend.PartyMember{{ID: hostID, DisplayName: "Host"}, {ID: map[bool]string{true: "other", false: "me"}[host], DisplayName: "Guest"}},
		Party:   &backend.PartyInfo{ID: "p1", Code: "ABCDEF", HostMemberID: hostID, Media: episode.wire(), MaxMembers: 8},
	}}
	if host {
		r.api.answer.Members = []backend.PartyMember{{ID: "me", DisplayName: "Me"}, {ID: "other", DisplayName: "Friend"}}
	} else {
		r.api.answer.Members = []backend.PartyMember{{ID: "other", DisplayName: "Host"}, {ID: "me", DisplayName: "Me"}}
	}
	r.s = NewService(r.api, func() (Me, error) {
		r.nowMu.Lock()
		defer r.nowMu.Unlock()
		return r.me, nil
	})
	r.s.now = r.time
	r.s.syncEvery, r.s.heartbeatEvery = time.Hour, time.Hour
	r.s.checkedAt = r.now.Add(time.Hour) // the backend's switch is on
	r.s.emit = func(name string, data any) {
		if n, ok := data.(Notice); ok && name == EventNotice {
			r.notices <- n
		}
	}
	UsePlayer(r.s, r.player)
	t.Cleanup(func() {
		r.s.mu.Lock()
		if r.s.cur != nil {
			r.s.stop(r.s.cur)
		}
		r.s.mu.Unlock()
	})
	return r
}

func (r *rig) time() time.Time {
	r.nowMu.Lock()
	defer r.nowMu.Unlock()
	return r.now
}

func (r *rig) advance(d time.Duration) {
	r.nowMu.Lock()
	r.now = r.now.Add(d)
	r.nowMu.Unlock()
	r.player.set(func(st *player.State) {
		if st.Active && !st.Loading && !st.Paused {
			st.Position += d.Seconds() * st.Speed
		}
	})
}

// playing has the player show the episode at position, playing.
func (r *rig) playing(position float64) {
	r.player.set(func(st *player.State) {
		*st = player.State{Active: true, Speed: 1, Time: player.Time{Position: position, Duration: 3000}}
	})
	r.s.Watch(&episode, nil)
}

// tick runs one turn of the session's loop.
func (r *rig) tick() {
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	if sess := r.s.cur; sess != nil {
		r.s.followPlayer(sess)
		r.s.coordinate(sess)
		r.s.changed()
	}
}

func (r *rig) connect(t *testing.T) *fakeChannel {
	t.Helper()
	ch := r.api.channel(t)
	ch.handler.Connected(true)
	return ch
}

func (r *rig) notice(t *testing.T, kind string) Notice {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case n := <-r.notices:
			if n.Kind == kind {
				return n
			}
		case <-deadline:
			t.Fatalf("no %s notice", kind)
		}
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not within 2 s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func playbackOf(t *testing.T, data json.RawMessage) backend.PartyPlayback {
	t.Helper()
	var p backend.PartyPlayback
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHostStartsFromThePlayer(t *testing.T) {
	r := newRig(t, true)
	r.playing(120)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	st := r.s.State()
	if st.Party == nil || !st.Party.IsHost || !st.Party.Watching || st.Party.Code != "ABCDEF" {
		t.Fatalf("state = %+v", st.Party)
	}
	ch := r.connect(t)
	eventually(t, "joining the channel asks the others for the state", func() bool { return ch.count("state_request") == 1 })
	eventually(t, "joining the channel tracks this member's presence", func() bool {
		ch.mu.Lock()
		defer ch.mu.Unlock()
		return len(ch.tracked) == 1
	})

	// The host's first frame is the party's first playback.
	r.tick()
	first := playbackOf(t, ch.lastSent(t, "state"))
	if first.Seq != 1 || first.Paused || first.PositionMs != 120_000 || first.MediaKey != episode.Key() || first.MemberID != "me" {
		t.Errorf("first playback = %+v", first)
	}
	// And it's kept with the backend once it settles.
	eventually(t, "the playback is persisted", func() bool { return r.api.called("update") })

	// The host pausing is published before mpv pauses.
	if !GateOf(r.s).UserPause(true) {
		t.Fatal("the host's pause was refused")
	}
	ch.stateWith(t, "the host's pause", func(p backend.PartyPlayback) bool { return p.Seq == 2 && p.Paused })
	// Seeking too.
	if to, ok := GateOf(r.s).UserSeek(600); !ok || to != 600 {
		t.Fatalf("the host's seek: %v, %v", to, ok)
	}
	ch.stateWith(t, "the host's seek", func(p backend.PartyPlayback) bool { return p.Seq == 3 && p.PositionMs == 600_000 })

	// The status goes out a moment later.
	var status presenceState
	json.Unmarshal(ch.lastSent(t, "status"), &status)
	if status.Status != StatusReady || status.MediaKey != episode.Key() {
		t.Errorf("status = %+v", status)
	}
}

func TestGuestFollowsTheParty(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.Join("abc def"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	r.playing(0)
	at := r.time().UnixMilli()
	ch.broadcast("state", backend.PartyPlayback{Seq: 5, MemberID: "other", PositionMs: 300_000, Rate: 1, At: at, MediaKey: episode.Key()})

	r.tick()
	st := r.player.Snapshot()
	if st.Paused || st.Position < 300 || st.Position > 300.1 {
		t.Errorf("after the host's state: paused %v at %.2f", st.Paused, st.Position)
	}
	// The host pauses: so does the guest, at the host's position.
	r.advance(10 * time.Second)
	ch.broadcast("state", backend.PartyPlayback{Seq: 6, MemberID: "other", Paused: true, PositionMs: 305_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	n := r.notice(t, NoticeAction)
	if n.Action != ActionPaused || n.Name != "Host" {
		t.Errorf("notice = %+v", n)
	}
	r.tick()
	st = r.player.Snapshot()
	if !st.Paused || st.Position != 305 {
		t.Errorf("after the host paused: paused %v at %.2f", st.Paused, st.Position)
	}
	// An older state is ignored.
	ch.broadcast("state", backend.PartyPlayback{Seq: 4, MemberID: "other", PositionMs: 0, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	r.tick()
	if st := r.player.Snapshot(); st.Position != 305 {
		t.Errorf("an older state moved the player to %.2f", st.Position)
	}
}

func TestDriftIsNudgedThenSeeked(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	r.playing(100)
	ch.broadcast("state", backend.PartyPlayback{Seq: 1, MemberID: "other", PositionMs: 100_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	r.tick() // applies the state
	r.advance(3 * time.Second)

	// 400 ms ahead: played a little slower.
	r.player.set(func(st *player.State) { st.Position += 0.4 })
	r.tick()
	if st := r.player.Snapshot(); st.Speed != 0.95 {
		t.Errorf("400 ms ahead: speed %v", st.Speed)
	}
	// Back in step: the party's rate again.
	r.advance(time.Second)
	r.player.set(func(st *player.State) { st.Position = 104 })
	r.tick()
	if st := r.player.Snapshot(); st.Speed != 1 {
		t.Errorf("in step: speed %v", st.Speed)
	}
	// 5 s behind: a seek.
	r.advance(time.Second)
	r.player.set(func(st *player.State) { st.Position = 100 })
	r.tick()
	if st := r.player.Snapshot(); st.Position < 105 {
		t.Errorf("5 s behind: at %.2f", st.Position)
	}
}

func TestHostOnlyGuest(t *testing.T) {
	r := newRig(t, false)
	r.api.answer.Party.HostOnly = true
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	r.playing(600)
	ch.broadcast("state", backend.PartyPlayback{Seq: 1, MemberID: "other", PositionMs: 600_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	r.tick()

	// Seeking ahead and speed are the host's.
	if _, ok := GateOf(r.s).UserSeek(900); ok {
		t.Error("a guest seeked ahead")
	}
	r.notice(t, NoticeLocked)
	if GateOf(r.s).UserSpeed(2) {
		t.Error("a guest changed the speed")
	}
	// A loop would pull them out of step.
	if GateOf(r.s).UserLoop() {
		t.Error("a guest set an A–B loop")
	}
	// A guest can pause for themselves: they watch on behind, and nothing
	// is published.
	sent := ch.count("state")
	if !GateOf(r.s).UserPause(true) {
		t.Fatal("a guest couldn't pause for themselves")
	}
	r.player.SetPaused(true)
	r.advance(20 * time.Second)
	r.tick()
	if st := r.s.State(); !st.Party.Behind || st.Party.BehindMs < 19_000 {
		t.Errorf("behind = %v, %d ms", st.Party.Behind, st.Party.BehindMs)
	}
	if ch.count("state") != sent {
		t.Error("a guest's own pause was published")
	}
	var status presenceState
	eventually(t, "a behind status", func() bool {
		json.Unmarshal(ch.lastSent(t, "status"), &status)
		return status.Status == StatusBehind
	})
	if status.BehindMs != 20_000 {
		t.Errorf("reported behind %d ms", status.BehindMs)
	}
	// Going back further is theirs too; catching up brings them back.
	if to, ok := GateOf(r.s).UserSeek(500); !ok || to != 500 {
		t.Errorf("seeking back while behind: %v, %v", to, ok)
	}
	r.s.CatchUp()
	r.player.SetPaused(false)
	r.tick()
	if st := r.s.State(); st.Party.Behind {
		t.Error("still behind after catching up")
	}
	if st := r.player.Snapshot(); st.Position < 620 || st.Paused {
		t.Errorf("after catching up: paused %v at %.2f", st.Paused, st.Position)
	}
}

func TestHostWaitsForLoadingMembers(t *testing.T) {
	r := newRig(t, true)
	r.playing(60)
	r.s.Create(episode)
	ch := r.connect(t)
	r.tick() // publishes the first playback

	ch.handler.Presence(map[string]json.RawMessage{"other": json.RawMessage(`{"member_id":"other","status":"loading","media_key":"` + episode.Key() + `"}`)}, nil)
	r.advance(4 * time.Second) // past the grace after resuming
	r.tick()
	ch.stateWith(t, "the party waits", func(p backend.PartyPlayback) bool { return p.Paused && p.Waiting })
	r.tick() // the host's own player follows
	if st := r.s.State(); len(st.Party.WaitingFor) != 1 || st.Party.WaitingFor[0] != "Friend" {
		t.Errorf("waiting for %v", st.Party.WaitingFor)
	}
	if st := r.player.Snapshot(); !st.Paused {
		t.Error("the host's player played on while waiting")
	}

	// Ready: the party plays on.
	ch.broadcast("status", presenceState{MemberID: "other", Status: StatusReady, MediaKey: episode.Key()})
	r.advance(time.Second)
	r.tick()
	ch.stateWith(t, "the party plays on", func(p backend.PartyPlayback) bool { return !p.Paused && !p.Waiting && p.Seq > 2 })
}

func TestStopsWaitingAfterAWhile(t *testing.T) {
	r := newRig(t, true)
	r.playing(60)
	r.s.Create(episode)
	ch := r.connect(t)
	r.tick()
	ch.handler.Presence(map[string]json.RawMessage{"other": json.RawMessage(`{"member_id":"other","status":"buffering","media_key":"` + episode.Key() + `"}`)}, nil)
	r.advance(4 * time.Second)
	r.tick()
	ch.stateWith(t, "the party waits", func(p backend.PartyPlayback) bool { return p.Waiting })
	r.advance(16 * time.Second)
	r.tick()
	ch.stateWith(t, "the party plays on after 15 s", func(p backend.PartyPlayback) bool { return !p.Paused && p.Seq == 3 })
	// And doesn't wait for them again until they're ready.
	r.advance(4 * time.Second)
	r.tick()
	time.Sleep(50 * time.Millisecond)
	if ch.count("state") != 3 {
		t.Error("waited again for the same member")
	}
}

func TestRemovedAndEnded(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	ch.broadcast("member_left", map[string]string{"member_id": "me", "reason": "removed"})
	r.notice(t, NoticeRemoved)
	if r.s.State().Party != nil {
		t.Error("still in the party after being removed")
	}

	r.s.Join("ABCDEF")
	ch = r.connect(t)
	ch.broadcast("ended", map[string]string{"reason": "host"})
	r.notice(t, NoticeEnded)
	if r.s.State().Party != nil {
		t.Error("still in the party after it ended")
	}
}

func TestHostLeftHandsOver(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	ch.broadcast("member_left", map[string]string{"member_id": "other", "reason": "left", "host_member_id": "me"})
	if n := r.notice(t, NoticeLeft); n.Name != "Host" {
		t.Errorf("left: %+v", n)
	}
	if st := r.s.State(); !st.Party.IsHost || len(st.Party.Members) != 1 {
		t.Errorf("after the host left: host %v, %d members", st.Party.IsHost, len(st.Party.Members))
	}
}

func TestPartyMovesOn(t *testing.T) {
	// A guest hears the party's new episode.
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	next := episode
	four := 4
	next.Episode, next.VideoID = &four, "tt123:1:4"
	ch.broadcast("media", map[string]any{"media": next.wire(), "playback": nil})
	if n := r.notice(t, NoticeMedia); n.Media == nil || n.Media.Key() != next.Key() {
		t.Errorf("media notice = %+v", n)
	}
	if st := r.s.State(); st.Party.Media.VideoID != "tt123:1:4" {
		t.Errorf("party media = %+v", st.Party.Media)
	}

	// The host playing the next episode moves the party.
	h := newRig(t, true)
	h.playing(2900)
	h.s.Create(episode)
	h.connect(t)
	h.tick()
	h.s.Watch(&next, nil)
	h.tick()
	eventually(t, "the new media goes to the backend", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		return len(h.api.media) == 1 && h.api.media[0].Key() == next.Key()
	})
}

func TestSharedStream(t *testing.T) {
	h := newRig(t, true)
	h.playing(10)
	h.s.Create(episode)
	ch := h.connect(t)
	stream := &Stream{URL: "https://debrid.example/d/file.mkv", Name: "1080p", Headers: map[string]string{"X": "y"}}
	h.s.Watch(&episode, stream)
	h.tick()
	if ch.count("stream") != 0 {
		t.Error("shared before the host chose to")
	}
	h.s.SetSharing(true)
	h.tick()
	var got struct {
		MemberID string     `json:"member_id"`
		Stream   wireStream `json:"stream"`
	}
	eventually(t, "the stream is shared", func() bool {
		return json.Unmarshal(ch.lastSent(t, "stream"), &got) == nil && got.Stream.URL != ""
	})
	if got.MemberID != "me" || got.Stream.URL != stream.URL || got.Stream.MediaKey != episode.Key() {
		t.Errorf("shared = %+v", got)
	}
	// A torrent's loopback link isn't shared.
	h.s.Watch(&episode, &Stream{URL: "http://127.0.0.1:4000/stream"})
	h.tick()
	eventually(t, "a loopback link isn't shared", func() bool {
		return string(ch.lastSent(t, "stream")) == `{"member_id":"me","stream":null}`
	})

	// The guest sees the host's link.
	g := newRig(t, false)
	g.s.Join("ABCDEF")
	gch := g.connect(t)
	gch.broadcast("stream", map[string]any{"member_id": "other", "stream": Stream{URL: stream.URL, MediaKey: episode.Key()}.wire()})
	if st := g.s.State(); st.Party.Shared == nil || st.Party.Shared.URL != stream.URL || st.Party.Shared.SharedBy != "Host" {
		t.Errorf("guest's shared = %+v", st.Party.Shared)
	}
	// Not from someone who isn't the host.
	gch.broadcast("stream", map[string]any{"member_id": "me", "stream": nil})
	if st := g.s.State(); st.Party.Shared == nil {
		t.Error("a non-host's stream message was taken")
	}
}

func TestChat(t *testing.T) {
	r := newRig(t, false)
	var mu sync.Mutex
	var chats []Chat
	r.s.emit = func(name string, data any) {
		if c, ok := data.(Chat); ok && name == EventChat {
			mu.Lock()
			chats = append(chats, c)
			mu.Unlock()
		}
	}
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	if err := r.s.SendMessage("  hello  "); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the message is sent", func() bool {
		c := r.s.Chat()
		return len(c.Messages) == 1 && c.Messages[0].Status == MessageSent && c.Messages[0].Body == "hello"
	})
	mu.Lock()
	sawSending := slices.ContainsFunc(chats, func(c Chat) bool {
		return len(c.Messages) == 1 && c.Messages[0].Status == MessageSending
	})
	mu.Unlock()
	if !sawSending {
		t.Error("the message didn't show as sending first")
	}
	// The backend's broadcast of it doesn't add it twice.
	ch.broadcast("chat", backend.PartyMessage{ID: 10, MemberID: "me", Body: "hello"})
	if c := r.s.Chat(); len(c.Messages) != 1 {
		t.Errorf("%d messages", len(c.Messages))
	}
	// Others' messages count as unread until the chat opens.
	ch.broadcast("chat", backend.PartyMessage{ID: 11, MemberID: "other", Name: "Host", Body: "hi"})
	if c := r.s.Chat(); c.Unread != 1 || len(c.Messages) != 2 || c.Messages[1].Mine {
		t.Errorf("chat = %+v", c)
	}
	r.s.SetChatOpen(true)
	ch.broadcast("chat", backend.PartyMessage{ID: 12, MemberID: "other", Name: "Host", Body: "there"})
	if c := r.s.Chat(); c.Unread != 0 {
		t.Errorf("unread %d with the chat open", c.Unread)
	}
}

func TestChatRetry(t *testing.T) {
	r := newRig(t, false)
	r.api.sendErr = context.DeadlineExceeded
	r.s.Join("ABCDEF")
	r.connect(t)
	r.s.SendMessage("hello")
	eventually(t, "the message fails", func() bool {
		c := r.s.Chat()
		return len(c.Messages) == 1 && c.Messages[0].Status == MessageFailed
	})
	r.api.mu.Lock()
	r.api.sendErr = nil
	r.api.mu.Unlock()
	r.s.RetryMessage(r.s.Chat().Messages[0].Key)
	eventually(t, "the retry is sent", func() bool {
		c := r.s.Chat()
		return len(c.Messages) == 1 && c.Messages[0].Status == MessageSent
	})
}

func TestUnavailable(t *testing.T) {
	r := newRig(t, false)
	r.me.Kids = true
	if err := r.s.Join("ABCDEF"); err == nil || err.(*Error).Code != WhyKids {
		t.Errorf("a kids profile joined: %v", err)
	}
	r.me.Kids, r.me.Linked = false, false
	if err := r.s.Create(episode); err == nil || err.(*Error).Code != WhySignIn {
		t.Errorf("an unlinked profile started a party: %v", err)
	}
	if st := r.s.State(); st.Unavailable != WhySignIn {
		t.Errorf("unavailable = %q", st.Unavailable)
	}
}

func TestSwitchingProfileLeaves(t *testing.T) {
	r := newRig(t, false)
	r.s.syncEvery = 10 * time.Millisecond
	r.s.Join("ABCDEF")
	r.connect(t)
	r.nowMu.Lock()
	r.me.ProfileID = 2
	r.nowMu.Unlock()
	r.notice(t, NoticeEnded)
	eventually(t, "the seat is given up", func() bool { return r.api.called("leave") })
}

func TestNotWatchingThePartyIsUngated(t *testing.T) {
	r := newRig(t, false)
	r.api.answer.Party.HostOnly = true
	r.s.Join("ABCDEF")
	r.connect(t)
	other := Media{Type: "movie", ID: "tt999", Title: "Something else"}
	r.player.set(func(st *player.State) { *st = player.State{Active: true, Speed: 1} })
	r.s.Watch(&other, nil)
	if _, ok := GateOf(r.s).UserSeek(100); !ok {
		t.Error("a seek in another title was refused")
	}
	if !GateOf(r.s).UserSpeed(2) {
		t.Error("a speed change in another title was refused")
	}
	if !GateOf(r.s).UserLoop() {
		t.Error("an A–B loop in another title was refused")
	}
	r.tick()
	if st := r.s.State(); st.Party.Watching {
		t.Error("watching the party's media")
	}
}

func TestStartAt(t *testing.T) {
	r := newRig(t, false)
	if got := r.s.StartAt(episode); got != -1 {
		t.Errorf("outside a party: %v", got)
	}
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	if got := r.s.StartAt(episode); got != -1 {
		t.Errorf("before any playback: %v", got)
	}
	ch.broadcast("state", backend.PartyPlayback{Seq: 1, MemberID: "other", PositionMs: 60_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	r.advance(5 * time.Second)
	if got := r.s.StartAt(episode); got != 65 {
		t.Errorf("start at %v, want 65", got)
	}
	if got := r.s.StartAt(Media{Type: "movie", ID: "tt9"}); got != -1 {
		t.Errorf("another title: %v", got)
	}
}

func TestHostSwitchesTheParty(t *testing.T) {
	h := newRig(t, true)
	h.s.Create(episode)
	h.connect(t)
	film := Media{Type: "movie", ID: "tt777", Title: "A film"}
	// Opening another title from browsing doesn't move the party.
	h.player.set(func(st *player.State) {
		*st = player.State{Active: true, Speed: 1, Time: player.Time{Position: 30, Duration: 6000}}
	})
	h.s.Watch(&film, nil)
	h.tick()
	h.tick()
	if st := h.s.State(); st.Party.Media.ID != episode.ID || st.Party.Watching {
		t.Fatalf("the party moved by itself: %+v", st.Party.Media)
	}
	// Switching does, from where the host is.
	if err := h.s.SwitchTo(film); err != nil {
		t.Fatal(err)
	}
	if st := h.s.State(); st.Party.Media.ID != "tt777" || !st.Party.Watching {
		t.Errorf("after switching: %+v", st.Party.Media)
	}
	eventually(t, "the switch goes to the backend", func() bool {
		h.api.mu.Lock()
		defer h.api.mu.Unlock()
		return len(h.api.media) == 1 && len(h.api.updates) > 0 && h.api.updates[len(h.api.updates)-1].PositionMs == 30_000
	})
	g := newRig(t, false)
	g.s.Join("ABCDEF")
	if err := g.s.SwitchTo(film); err == nil {
		t.Error("a guest switched the party")
	}
}
