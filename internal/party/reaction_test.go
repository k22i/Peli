package party

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// collectReactions collects what the service emits as EventReaction.
func collectReactions(r *rig) func() []Reaction {
	var mu sync.Mutex
	var got []Reaction
	r.s.emit = func(name string, data any) {
		if v, ok := data.(Reaction); ok && name == EventReaction {
			mu.Lock()
			got = append(got, v)
			mu.Unlock()
		}
	}
	return func() []Reaction {
		mu.Lock()
		defer mu.Unlock()
		return append([]Reaction(nil), got...)
	}
}

func TestReactionAllowList(t *testing.T) {
	r := newRig(t, false)
	r.s.Join("ABCDEF")
	r.connect(t)
	for _, bad := range []string{"", "x", "💩", "😂😂"} {
		if err := r.s.SendReaction(bad); err == nil || err.(*Error).Code != CodeInvalid {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
	if len(REACTIONS) != 8 {
		t.Errorf("%d reactions", len(REACTIONS))
	}
}

func TestReactionNotInParty(t *testing.T) {
	r := newRig(t, false)
	if err := r.s.SendReaction("🔥"); err == nil || err.(*Error).Code != CodeNotInParty {
		t.Errorf("err = %v", err)
	}
}

func TestReactionRateLimitAndEcho(t *testing.T) {
	r := newRig(t, false)
	got := collectReactions(r)
	r.s.Join("ABCDEF")
	ch := r.connect(t)
	if err := r.s.SendReaction("🔥"); err != nil {
		t.Fatal(err)
	}
	r.advance(100 * time.Millisecond)
	if err := r.s.SendReaction("🎉"); err != nil {
		t.Fatalf("a dropped reaction returned %v", err)
	}
	eventually(t, "a reaction frame", func() bool { return ch.count("reaction") == 1 })
	var w wireReaction
	if err := json.Unmarshal(ch.lastSent(t, "reaction"), &w); err != nil {
		t.Fatal(err)
	}
	if w.Emoji != "🔥" || w.MemberID != "me" || w.SentAt == 0 {
		t.Errorf("frame = %+v", w)
	}
	r.advance(250 * time.Millisecond)
	if err := r.s.SendReaction("🎉"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the second frame", func() bool { return ch.count("reaction") == 2 })
	list := got()
	if len(list) != 2 || !list[0].Mine || list[0].Emoji != "🔥" || list[1].Emoji != "🎉" || list[0].MemberID != "me" || list[0].Name != "Me" {
		t.Errorf("events = %+v", list)
	}
}

func TestIncomingReaction(t *testing.T) {
	r := newRig(t, false)
	got := collectReactions(r)
	r.s.Join("ABCDEF")
	ch := r.connect(t)

	ch.broadcast("reaction", wireReaction{Emoji: "😂", MemberID: "other", SentAt: 42})
	list := got()
	if len(list) != 1 || list[0] != (Reaction{Emoji: "😂", MemberID: "other", Name: "Host", At: 42}) {
		t.Fatalf("events = %+v", list)
	}

	// An emoji outside the list, and a bad payload, are dropped.
	r.advance(time.Second)
	ch.broadcast("reaction", wireReaction{Emoji: "💩", MemberID: "other", SentAt: 1})
	ch.broadcast("reaction", "nonsense")
	ch.broadcast("reaction", wireReaction{Emoji: "🔥", SentAt: 1})
	if n := len(got()); n != 1 {
		t.Errorf("%d events after bad ones", n)
	}

	// A flood from one member is limited.
	ch.broadcast("reaction", wireReaction{Emoji: "🔥", MemberID: "other", SentAt: 2})
	ch.broadcast("reaction", wireReaction{Emoji: "🔥", MemberID: "other", SentAt: 3})
	if n := len(got()); n != 2 {
		t.Errorf("%d events after a flood", n)
	}

	// Our own id is Mine; a member the session doesn't know has no name.
	ch.broadcast("reaction", wireReaction{Emoji: "❤️", MemberID: "me", SentAt: 4})
	ch.broadcast("reaction", wireReaction{Emoji: "🍿", MemberID: "ghost", SentAt: 5})
	list = got()
	if len(list) != 4 || !list[2].Mine || list[2].Name != "Me" || list[3].Mine || list[3].Name != "" {
		t.Errorf("events = %+v", list)
	}
}
