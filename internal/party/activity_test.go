package party

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// collectActivity collects what the service emits as EventActivity.
func collectActivity(r *rig) func() []Activity {
	var mu sync.Mutex
	var got []Activity
	r.s.emit = func(name string, data any) {
		if v, ok := data.(Activity); ok && name == EventActivity {
			mu.Lock()
			got = append(got, v)
			mu.Unlock()
		}
	}
	return func() []Activity {
		mu.Lock()
		defer mu.Unlock()
		return append([]Activity(nil), got...)
	}
}

func TestActivityOutsideParty(t *testing.T) {
	r := newRig(t, false)
	if got := r.s.Activity(); got.Entries == nil || len(got.Entries) != 0 {
		t.Errorf("entries = %#v", got.Entries)
	}
}

func TestActivityAnotherMembersPause(t *testing.T) {
	r := newRig(t, false)
	got := collectActivity(r)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	ch.broadcast("state", backend.PartyPlayback{
		Seq: 5, MemberID: "other", PositionMs: 300_000, Rate: 1, At: r.time().UnixMilli(), MediaKey: episode.Key(),
	})
	r.advance(10 * time.Second)
	ch.broadcast("state", backend.PartyPlayback{
		Seq: 6, MemberID: "other", Paused: true, PositionMs: 305_000, Rate: 1,
		At: r.time().UnixMilli(), MediaKey: episode.Key(),
	})

	list := r.s.Activity().Entries
	if len(list) != 2 {
		t.Fatalf("log = %+v", list)
	}
	// The log starts with this member coming in, then the host paused.
	if list[0].Kind != ActivityJoined || list[0].MemberID != "me" || !list[0].Mine {
		t.Errorf("first entry = %+v", list[0])
	}
	pause := list[1]
	if pause.Kind != ActivityPaused || pause.ID != "pb:other:6" || pause.MemberID != "other" ||
		pause.Name != "Host" || pause.PositionMs != 305_000 || pause.Mine {
		t.Errorf("pause = %+v", pause)
	}
	// Every change sends the whole log.
	events := got()
	if len(events) == 0 || len(events[len(events)-1].Entries) != 2 {
		t.Errorf("events = %+v", events)
	}
}

func TestActivityOwnPause(t *testing.T) {
	r := newRig(t, true)
	got := collectActivity(r)
	r.playing(120)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	r.connect(t)
	r.tick() // the host's first playback, which isn't anything they did
	if !GateOf(r.s).UserPause(true) {
		t.Fatal("the host's pause was refused")
	}

	list := r.s.Activity().Entries
	if len(list) != 2 {
		t.Fatalf("log = %+v", list)
	}
	pause := list[1]
	if pause.Kind != ActivityPaused || pause.ID != "pb:me:2" || pause.MemberID != "me" ||
		pause.Name != "Me" || pause.PositionMs != 120_000 || !pause.Mine {
		t.Errorf("pause = %+v", pause)
	}
	events := got()
	if len(events) != 2 || len(events[1].Entries) != 2 || !events[1].Entries[1].Mine {
		t.Errorf("events = %+v", events)
	}
}

func TestActivitySeeksCollapse(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	// The party is paused at 100 s, and the host seeks twice, two seconds
	// apart: one line, at the second position.
	ch.broadcast("state", backend.PartyPlayback{
		Seq: 1, MemberID: "other", Paused: true, PositionMs: 100_000, Rate: 1,
		At: r.time().UnixMilli(), MediaKey: episode.Key(),
	})
	ch.broadcast("state", backend.PartyPlayback{
		Seq: 2, MemberID: "other", Paused: true, PositionMs: 130_000, Rate: 1,
		At: r.time().UnixMilli(), MediaKey: episode.Key(),
	})
	r.advance(2 * time.Second)
	ch.broadcast("state", backend.PartyPlayback{
		Seq: 3, MemberID: "other", Paused: true, PositionMs: 160_000, Rate: 1,
		At: r.time().UnixMilli(), MediaKey: episode.Key(),
	})

	list := r.s.Activity().Entries
	if len(list) != 2 {
		t.Fatalf("log = %+v", list)
	}
	seek := list[1]
	if seek.Kind != ActivitySeeked || seek.PositionMs != 160_000 || seek.ID != "pb:other:2" {
		t.Errorf("seek = %+v", seek)
	}
}

func TestActivityMediaLine(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	next := episode
	next.VideoID, next.Episode = "tt123:1:4", func() *int { n := 4; return &n }()
	ch.broadcast("media", map[string]any{"media": next.wire()})

	list := r.s.Activity().Entries
	if len(list) != 2 {
		t.Fatalf("log = %+v", list)
	}
	started := list[1]
	if started.Kind != ActivityMedia || started.MemberID != "other" || started.Title != "A show S1 E4" ||
		started.ID != "media:"+next.Key() {
		t.Errorf("media entry = %+v (key %q)", started, next.Key())
	}
	// Every member makes the same line for the same thing.
	if mediaTitle(next.wire()) != "A show S1 E4" || mediaTitle(backend.PartyMedia{}) != "" {
		t.Errorf("title = %q", mediaTitle(next.wire()))
	}
}

func TestActivityHandsOverTheLog(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	// A member who came later asks; this one answers, a moment later.
	ch.broadcast("activity_request", map[string]string{"member_id": "other"})
	eventually(t, "an activity frame", func() bool { return ch.count("activity") == 1 })

	var w wireActivityLog
	if err := json.Unmarshal(ch.lastSent(t, "activity"), &w); err != nil {
		t.Fatal(err)
	}
	if w.To != "other" || w.From != "me" || len(w.Entries) != 1 {
		t.Fatalf("hand-over = %+v", w)
	}
	if w.Entries[0].ID != "joined:me" || w.Entries[0].MemberID != "me" || w.Entries[0].At == 0 {
		t.Errorf("entry = %+v", w.Entries[0])
	}
}

func TestActivityLogIsMerged(t *testing.T) {
	r := newRig(t, false)
	got := collectActivity(r)
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	ch := r.connect(t)
	at := r.time().UnixMilli()
	log := wireActivityLog{From: "other", Entries: []wireActivity{
		// Out of order, and two that are dropped.
		{ID: "pb:other:9", Kind: ActivityPaused, MemberID: "other", PositionMs: 60_000, At: at + 3000},
		{ID: "joined:other", Kind: ActivityJoined, MemberID: "other", At: at - 3000},
		{ID: "x:1", Kind: "danced", MemberID: "other", At: at},
		{ID: "", Kind: ActivityLeft, MemberID: "other", At: at},
	}}
	ch.broadcast("activity", log)

	list := r.s.Activity().Entries
	if len(list) != 3 {
		t.Fatalf("log = %+v", list)
	}
	if list[0].ID != "joined:other" || list[1].ID != "joined:me" || list[2].ID != "pb:other:9" {
		t.Errorf("order = %+v", list)
	}
	if list[0].Name != "Host" || list[0].At != at-3000 || list[2].MemberID != "other" || list[2].Mine {
		t.Errorf("merged = %+v", list)
	}

	// The same log again fills no gaps, and sends nothing.
	emitted := len(got())
	ch.broadcast("activity", log)
	if n := len(r.s.Activity().Entries); n != 3 || len(got()) != emitted {
		t.Errorf("%d entries, %d events after the same log again", n, len(got()))
	}
}
