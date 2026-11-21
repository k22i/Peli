package party

import (
	"testing"
	"time"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/playback"
)

// serverNow has the fake backend's answers carry the clock as it is now.
func (r *rig) serverNow() {
	r.api.mu.Lock()
	r.api.answer.ServerTimeMs = r.time().UnixMilli()
	r.api.mu.Unlock()
}

func (r *rig) channels() int {
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	return len(r.api.channels)
}

func TestGuestAwayThenBackCatchesUpToTheHost(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	first := r.connect(t)
	r.playing(0)
	startedAt := r.time().UnixMilli()
	first.broadcast("state", backend.PartyPlayback{Seq: 5, MemberID: "other", PositionMs: 300_000, Rate: 1, At: startedAt, MediaKey: episode.Key()})
	r.tick()

	// The app is suspended: the player paused where it was, the socket
	// closed on purpose, the seat kept.
	r.player.set(func(st *playback.State) { st.Paused = true })
	Away(r.s)
	if first.closes() != 1 {
		t.Fatalf("the channel was closed %d times", first.closes())
	}
	if st := r.s.State(); st.Party == nil || st.Party.Connected {
		t.Fatalf("while away: %+v", st.Party)
	}
	if r.api.called("leave") {
		t.Error("going away left the party")
	}
	Away(r.s) // twice is the same
	if first.closes() != 1 {
		t.Error("away closed the channel again")
	}

	// A minute later the host has played on.
	r.advance(time.Minute)
	r.serverNow()
	Back(r.s)

	if r.channels() != 2 {
		t.Fatalf("%d channels opened, want a second after coming back", r.channels())
	}
	if !r.api.called("join") {
		t.Error("coming back didn't join again")
	}
	st := r.player.Snapshot()
	if st.Paused || st.Position < 360 || st.Position > 360.2 {
		t.Errorf("after coming back: paused %v at %.2f, want playing at 360", st.Paused, st.Position)
	}
	// The new channel tells the others where this member is.
	second := r.connect(t)
	eventually(t, "state_request on the new channel", func() bool { return second.count("state_request") == 1 })
	if s := r.s.State(); s.Party == nil || !s.Party.Connected {
		t.Errorf("after coming back: %+v", s.Party)
	}
	// And Back doesn't run twice.
	Back(r.s)
	if r.channels() != 2 {
		t.Error("a second Back opened another channel")
	}
}

func TestPartyEndedWhileAway(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	r.connect(t)
	Away(r.s)

	r.api.mu.Lock()
	r.api.answer = backend.PartySnapshot{Error: backend.PartyEnded}
	r.api.mu.Unlock()
	Back(r.s)
	r.notice(t, NoticeEnded)
	if r.s.State().Party != nil {
		t.Error("still in a party that ended while away")
	}
}

func TestRemovedWhileAway(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	r.connect(t)
	Away(r.s)

	r.api.mu.Lock()
	r.api.answer = backend.PartySnapshot{Error: backend.PartyRemoved}
	r.api.mu.Unlock()
	Back(r.s)
	r.notice(t, NoticeRemoved)
	if r.s.State().Party != nil {
		t.Error("still in the party after being removed while away")
	}
}

func TestHostComingBackRepublishesItsOwnState(t *testing.T) {
	r := newRig(t, true)
	r.playing(120)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	first := r.connect(t)
	r.tick()
	first.stateWith(t, "the first playback", func(p backend.PartyPlayback) bool { return p.Seq == 1 && p.PositionMs == 120_000 })

	// Suspended 30 s on: the player paused at 150, though the party's last
	// playback says playing from 120 (a guest following it would be at
	// 210 by now).
	r.advance(30 * time.Second)
	r.player.set(func(st *playback.State) { st.Paused = true })
	Away(r.s)
	if r.api.called("end") || r.api.called("leave") {
		t.Fatal("the host's going away ended or left the party")
	}
	r.advance(time.Minute)
	r.serverNow()
	Back(r.s)

	second := r.connect(t)
	pb := second.stateWith(t, "the host's state", func(p backend.PartyPlayback) bool { return p.Seq == 2 })
	if !pb.Paused || pb.PositionMs != 150_000 || pb.MemberID != "me" {
		t.Errorf("republished %+v, want paused at 150 s", pb)
	}
	if st := r.player.Snapshot(); st.Position != 150 || !st.Paused {
		t.Errorf("the host's player moved to %.2f (paused %v)", st.Position, st.Paused)
	}
	if st := r.s.State(); st.Party == nil || !st.Party.IsHost {
		t.Errorf("after coming back: %+v", st.Party)
	}
}

func TestHostOnlyGuestFollowsAfterBack(t *testing.T) {
	r := newRig(t, false)
	r.api.answer.Party.HostOnly = true
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	r.playing(0)
	ch.broadcast("state", backend.PartyPlayback{Seq: 2, MemberID: "other", Paused: true, PositionMs: 40_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()})
	r.tick()
	Away(r.s)

	// The host played on meanwhile: the backend has it.
	r.advance(10 * time.Second)
	r.api.mu.Lock()
	info := *r.api.answer.Party
	info.Playback = &backend.PartyPlayback{Seq: 3, MemberID: "other", PositionMs: 50_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key()}
	r.api.answer.Party = &info
	r.api.mu.Unlock()
	r.serverNow()
	Back(r.s)

	if st := r.player.Snapshot(); st.Paused || st.Position < 50 || st.Position > 50.2 {
		t.Errorf("after coming back: paused %v at %.2f, want playing at 50", st.Paused, st.Position)
	}
	// A guest never publishes.
	if len(r.api.updates) != 0 {
		t.Errorf("a host-only guest published %+v", r.api.updates)
	}
}

// A relaunch after the app was killed starts with no party: a session is
// only in memory, nothing was left to rejoin, and the backend lets the old
// seat time out. Away and Back with nothing to come back to do nothing.
func TestRelaunchStartsWithoutAParty(t *testing.T) {
	r := newRig(t, false)
	if st := r.s.State(); st.Party != nil {
		t.Fatalf("a new service is in a party: %+v", st.Party)
	}
	Back(r.s)
	Away(r.s)
	Back(r.s)
	if r.api.called("join") || r.api.called("leave") || r.channels() != 0 {
		t.Errorf("calls %v, channels %d", r.api.calls, r.channels())
	}
}
