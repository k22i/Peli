package party

import (
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/store"
)

func TestExpectedPosition(t *testing.T) {
	playing := backend.PartyPlayback{PositionMs: 10_000, Rate: 1.5, At: 1_000}
	for _, tc := range []struct {
		name     string
		p        backend.PartyPlayback
		now, dur int64
		want     int64
	}{
		{"moves at its rate", playing, 3_000, 0, 13_000},
		{"stops at the end", playing, 3_000, 12_000, 12_000},
		{"a time before at doesn't go back", playing, 0, 0, 10_000},
		{"paused stays", backend.PartyPlayback{PositionMs: 5_000, Paused: true, At: 1_000}, 9_000, 0, 5_000},
		{"no rate is 1", backend.PartyPlayback{PositionMs: 0, At: 0}, 2_000, 0, 2_000},
	} {
		if got := expectedPosition(tc.p, tc.now, tc.dur); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestCorrect(t *testing.T) {
	playing := backend.PartyPlayback{Rate: 1}
	paused := backend.PartyPlayback{Rate: 1, Paused: true}
	for _, tc := range []struct {
		name            string
		local, expected int64
		p               backend.PartyPlayback
		nudging         bool
		want            correction
	}{
		{"close enough", 10_200, 10_000, playing, false, correction{kind: inSync}},
		{"ahead: slower", 10_400, 10_000, playing, false, correction{kind: nudge, rate: 0.95}},
		{"behind: faster", 9_600, 10_000, playing, false, correction{kind: nudge, rate: 1.05}},
		{"nudging stops nearer", 10_100, 10_000, playing, true, correction{kind: nudge, rate: 0.95}},
		{"nudged in", 10_050, 10_000, playing, true, correction{kind: inSync}},
		{"far: seek", 12_000, 10_000, playing, false, correction{kind: seekTo, positionMs: 10_000}},
		{"paused, near", 10_400, 10_000, paused, false, correction{kind: inSync}},
		{"paused, off", 10_600, 10_000, paused, false, correction{kind: seekTo, positionMs: 10_000}},
	} {
		got := correct(tc.local, tc.expected, tc.p, tc.nudging)
		if got.kind != tc.want.kind || got.positionMs != tc.want.positionMs || (got.rate-tc.want.rate) > 1e-9 || (tc.want.rate-got.rate) > 1e-9 {
			t.Errorf("%s: %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestNewer(t *testing.T) {
	current := &backend.PartyPlayback{Seq: 3, MemberID: "b"}
	for _, tc := range []struct {
		candidate backend.PartyPlayback
		want      bool
	}{
		{backend.PartyPlayback{Seq: 4, MemberID: "a"}, true},
		{backend.PartyPlayback{Seq: 2, MemberID: "z"}, false},
		{backend.PartyPlayback{Seq: 3, MemberID: "c"}, true},
		{backend.PartyPlayback{Seq: 3, MemberID: "a"}, false},
	} {
		if got := newer(tc.candidate, current); got != tc.want {
			t.Errorf("newer(%+v) = %v", tc.candidate, got)
		}
	}
	if !newer(backend.PartyPlayback{}, nil) {
		t.Error("anything is newer than nothing")
	}
}

func TestActionOf(t *testing.T) {
	prev := &backend.PartyPlayback{PositionMs: 10_000, Rate: 1, At: 0, MediaKey: "k"}
	for _, tc := range []struct {
		name string
		next backend.PartyPlayback
		want string
	}{
		{"paused", backend.PartyPlayback{Paused: true, PositionMs: 11_000, Rate: 1, At: 1_000, MediaKey: "k"}, ActionPaused},
		{"speed", backend.PartyPlayback{PositionMs: 11_000, Rate: 2, At: 1_000, MediaKey: "k"}, ActionSpeed},
		{"seeked", backend.PartyPlayback{PositionMs: 60_000, Rate: 1, At: 1_000, MediaKey: "k"}, ActionSeeked},
		{"nothing", backend.PartyPlayback{PositionMs: 11_500, Rate: 1, At: 1_000, MediaKey: "k"}, ""},
		{"waiting says nothing", backend.PartyPlayback{Paused: true, Waiting: true, MediaKey: "k"}, ""},
		{"other media", backend.PartyPlayback{Paused: true, MediaKey: "j"}, ""},
	} {
		if got := actionOf(prev, tc.next); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
	resumed := backend.PartyPlayback{PositionMs: 10_000, Rate: 1, At: 1_000, MediaKey: "k"}
	if got := actionOf(&backend.PartyPlayback{Paused: true, PositionMs: 10_000, Rate: 1, MediaKey: "k"}, resumed); got != ActionResumed {
		t.Errorf("resumed: %q", got)
	}
}

func TestOwnSeekAndGap(t *testing.T) {
	if got := ownSeek(10_000, 20_000, false); got != seekBehind {
		t.Errorf("back 10 s: %d", got)
	}
	if got := ownSeek(19_000, 20_000, false); got != seekBlocked {
		t.Errorf("back 1 s: %d", got)
	}
	if got := ownSeek(25_000, 20_000, true); got != seekCatchUp {
		t.Errorf("forward while behind: %d", got)
	}
	for gap, want := range map[int64]int64{0: 5_000, 3_000: 5_000, 7_400: 5_000, 7_500: 10_000, 61_000: 60_000} {
		if got := reportedGap(gap); got != want {
			t.Errorf("reportedGap(%d) = %d, want %d", gap, got, want)
		}
	}
}

func TestCoordinator(t *testing.T) {
	members := []backend.PartyMember{{ID: "host"}, {ID: "a"}, {ID: "b"}}
	for _, tc := range []struct {
		name     string
		online   []string
		self     string
		hostOnly bool
		want     string
	}{
		{"the host while online", []string{"host", "a"}, "a", false, "host"},
		{"the host itself", nil, "host", false, "host"},
		{"first online without the host", []string{"b"}, "a", false, "a"},
		{"first online in order", []string{"a", "b"}, "b", false, "a"},
		{"only the host, even away", []string{"a"}, "a", true, "host"},
	} {
		online := map[string]bool{}
		for _, id := range tc.online {
			online[id] = true
		}
		if got := coordinator(members, online, tc.self, "host", tc.hostOnly); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestWaitingMembers(t *testing.T) {
	presence := map[string]presenceState{
		"a": {Status: StatusLoading, MediaKey: "k"},
		"b": {Status: StatusBuffering, MediaKey: "k"},
		"c": {Status: StatusReady, MediaKey: "k"},
		"d": {Status: StatusLoading, MediaKey: "other"},
	}
	got := waitingMembers(presence, "k", map[string]bool{"b": true})
	if len(got) != 1 || got[0] != "a" {
		t.Errorf("waiting = %v", got)
	}
}

func TestClock(t *testing.T) {
	now := time.Unix(1000, 0)
	c := newClock(func() time.Time { return now })
	if c.nowMs() != now.UnixMilli() {
		t.Error("before a sample the clock is the wall clock")
	}
	sent := now
	now = now.Add(200 * time.Millisecond)
	c.add(5_000_000, sent) // 200 ms round trip: the server was 100 ms in
	if got := c.nowMs(); got != 5_000_100 {
		t.Errorf("after a sample: %d", got)
	}
	sent = now
	now = now.Add(600 * time.Millisecond)
	c.add(9_999_999, sent) // a slower sample is ignored
	if got := c.nowMs(); got != 5_000_700 {
		t.Errorf("after a slower sample: %d", got)
	}
	sent = now
	c.add(7_000_000, sent) // instant: taken
	if got := c.nowMs(); got != 7_000_000 {
		t.Errorf("after a quicker sample: %d", got)
	}
}

func TestNormalizeCodeAndShareable(t *testing.T) {
	if got := NormalizeCode(" abc-d e f "); got != "ABCDEF" {
		t.Errorf("code %q", got)
	}
	if got := NormalizeCode("10OI"); got != "" {
		t.Errorf("0, 1, O and I aren't in codes: %q", got)
	}
	for url, want := range map[string]bool{
		"https://real-debrid.example/d/abc": true,
		"http://cdn.example/x.mkv":          true,
		"http://127.0.0.1:8080/stream":      false,
		"http://localhost/x":                false,
		"magnet:?xt=urn:btih:abc":           false,
		"":                                  false,
	} {
		if got := shareable(url); got != want {
			t.Errorf("shareable(%q) = %v", url, got)
		}
	}
}

func TestMeOf(t *testing.T) {
	index := 2
	me := meOf(store.Profile{
		ID: 7, Name: "  Kev  ", Avatar: "http://not-https/a.png", AvatarColor: "#33B5E0", NuvioIndex: &index,
	}, "sinag-device", true)
	if !me.Linked || me.Identity.DisplayName != "Kev" || me.Identity.AvatarURL != "" ||
		me.Identity.AvatarColor != "#33B5E0" || *me.Identity.ProfileIndex != 2 || me.Identity.DeviceID != "sinag-device" {
		t.Errorf("me = %+v", me)
	}
	if meOf(store.Profile{Guest: true, NuvioIndex: &index}, "d", true).Linked {
		t.Error("a Guest isn't linked")
	}
	if meOf(store.Profile{NuvioIndex: &index}, "d", false).Linked {
		t.Error("signed out isn't linked")
	}
	if name := meOf(store.Profile{}, "d", true).Identity.DisplayName; name != "Sinag" {
		t.Errorf("no name: %q", name)
	}
}
