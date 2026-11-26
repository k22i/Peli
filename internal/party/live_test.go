package party

import (
	"cmp"
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/playback"
)

// fixedSession hands out one session, as account.Session would.
type fixedSession struct{ s nuvio.Session }

func (f fixedSession) Do(_ context.Context, fn func(nuvio.Session) error) error { return fn(f.s) }

// TestLiveTwoMembers runs two members of one party against api.nuvio.tv,
// each with a player that plays by itself: the guest's player catches up
// with the host's, follows the host's pause, and the chat goes both ways.
// The party is ended and the session signed out after. It runs only with
// PELI_NUVIO_LIVE_WRITES=1 and NUVIO_EMAIL and NUVIO_PASSWORD.
func TestLiveTwoMembers(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE_WRITES") != "1" {
		t.Skip("set PELI_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD to run a party on a live backend")
	}
	c := nuvio.New(cmp.Or(os.Getenv("NUVIO_URL"), nuvio.DefaultURL), "0.0.0-live-test")
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil && !errors.Is(err, nuvio.ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	api := backend.Parties{Client: c, Sessions: fixedSession{s}}
	member := func(device, name string) (*Service, *livePlayer) {
		index := 1
		svc := NewService(api, func() (Me, error) {
			return Me{ProfileID: 1, Linked: true, Identity: backend.PartyIdentity{
				DeviceID: device + "-" + time.Now().Format("150405"), DisplayName: name, ProfileIndex: &index,
			}}, nil
		})
		p := &livePlayer{}
		UsePlayer(svc, p)
		return svc, p
	}
	host, hostPlayer := member("peli-live-host", "Peli test host")
	guest, guestPlayer := member("peli-live-guest", "Peli test guest")
	t.Cleanup(func() {
		host.End()
		guest.Leave()
	})

	film := Media{Type: "movie", ID: "tt0000001", Title: "Peli live test", Source: &Source{Filename: "peli.live.mkv"}}
	hostPlayer.play(100)
	host.Watch(&film, nil)
	if err := host.Create(film); err != nil {
		t.Fatal(err)
	}
	code := host.State().Party.Code
	if err := guest.Join(code); err != nil {
		t.Fatal(err)
	}
	guestPlayer.play(0)
	guest.Watch(&film, nil)

	wait := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("%s: not within 20 s (host at %.1f, guest at %.1f)", what, hostPlayer.position(), guestPlayer.position())
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	wait("both are on the channel", func() bool {
		h, g := host.State().Party, guest.State().Party
		return h != nil && g != nil && h.Connected && g.Connected
	})
	wait("the guest sees the host watching", func() bool {
		for _, m := range guest.State().Party.Members {
			if m.Host && m.Status == StatusReady {
				return true
			}
		}
		return false
	})
	// In step: within the nudge's reach of the host.
	wait("the guest's player catches up with the host's", func() bool {
		return math.Abs(guestPlayer.position()-hostPlayer.position()) < 0.4
	})
	t.Logf("in step: host %.2f s, guest %.2f s", hostPlayer.position(), guestPlayer.position())

	// The host pauses: the gate publishes it, and the guest follows.
	if !GateOf(host).UserPause(true) {
		t.Fatal("the host's pause was refused")
	}
	hostPlayer.SetPaused(true)
	wait("the guest pauses with the host", func() bool { return guestPlayer.paused() })
	if gap := math.Abs(guestPlayer.position() - hostPlayer.position()); gap > 0.6 {
		t.Errorf("paused %.2f s apart", gap)
	}

	// The guest resumes (everyone can control): the host follows.
	if !GateOf(guest).UserPause(false) {
		t.Fatal("the guest's resume was refused")
	}
	guestPlayer.SetPaused(false)
	wait("the host resumes with the guest", func() bool { return !hostPlayer.paused() })

	if err := guest.SendMessage("hello from Peli's live test"); err != nil {
		t.Fatal(err)
	}
	wait("the host gets the message", func() bool {
		chat := host.Chat()
		return len(chat.Messages) == 1 && !chat.Messages[0].Mine && chat.Messages[0].Name == "Peli test guest"
	})
	wait("the guest's message is sent", func() bool {
		chat := guest.Chat()
		return len(chat.Messages) == 1 && chat.Messages[0].Mine && chat.Messages[0].Status == MessageSent
	})

	if err := host.End(); err != nil {
		t.Fatal(err)
	}
	wait("the guest hears the end", func() bool { return guest.State().Party == nil })
}

// livePlayer plays by the wall clock, as mpv would.
type livePlayer struct {
	mu    sync.Mutex
	st    playback.State
	since time.Time
}

func (p *livePlayer) advance() {
	now := time.Now()
	if !p.since.IsZero() && p.st.Active && !p.st.Paused {
		p.st.Position += now.Sub(p.since).Seconds() * p.st.Speed
	}
	p.since = now
}

func (p *livePlayer) play(at float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st = playback.State{Active: true, Speed: 1, Time: playback.Time{Position: at, Duration: 7200}}
	p.since = time.Now()
}

func (p *livePlayer) position() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.advance()
	return p.st.Position
}

func (p *livePlayer) paused() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.st.Paused
}

func (p *livePlayer) Snapshot() playback.State {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.advance()
	return p.st
}

func (p *livePlayer) SetPaused(paused bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.advance()
	p.st.Paused = paused
	return nil
}

func (p *livePlayer) Seek(position float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.advance()
	p.st.Position = position
	return nil
}

func (p *livePlayer) SetSpeed(speed float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.advance()
	p.st.Speed = speed
	return nil
}

// TestLivePartyAnnouncement announces a party on the real account and checks
// the account's synced data: the party appears there under the platform key
// Peli owns (ADR-0067), another profile of the account can read it, and it is
// gone again when the party ends. It runs only with
// PELI_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD, and leaves the
// account's rows as it found them.
func TestLivePartyAnnouncement(t *testing.T) {
	if os.Getenv("PELI_NUVIO_LIVE_WRITES") != "1" {
		t.Skip("set PELI_NUVIO_LIVE_WRITES=1, NUVIO_EMAIL and NUVIO_PASSWORD to announce a party on a live backend")
	}
	c := nuvio.New(cmp.Or(os.Getenv("NUVIO_URL"), nuvio.DefaultURL), "0.0.0-live-test")
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	// Not t.Context(): it is cancelled before cleanups run.
	ctx := context.Background()
	t.Cleanup(func() {
		if err := c.SignOut(ctx, s); err != nil && !errors.Is(err, nuvio.ErrSignedOut) {
			t.Errorf("sign out: %v", err)
		}
	})
	rows := func() []nuvio.SettingsBlobRow {
		t.Helper()
		got, err := c.ProfileSettingsList(ctx, s, nuvio.PlatformPeli)
		if err != nil {
			t.Logf("listing %q rows: %v", nuvio.PlatformPeli, err)
			return nil
		}
		return got
	}
	baseline := rows()
	if len(baseline) != 0 {
		t.Fatalf("the account has %d %q rows before the test: remove them with DELETE /rest/v1/profile_settings_blobs?platform=eq.%s",
			len(baseline), nuvio.PlatformPeli, nuvio.PlatformPeli)
	}

	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) == 0 {
		t.Fatal("the account has no profiles")
	}
	index := profiles[0].Index
	api := backend.Parties{Client: c, Sessions: fixedSession{s}}
	svc := NewService(api, func() (Me, error) {
		return Me{ProfileID: 1, Linked: true, Identity: backend.PartyIdentity{
			DeviceID: "peli-live-announce-" + time.Now().Format("150405"), DisplayName: "Peli live test",
			ProfileIndex: &index,
		}}, nil
	})
	t.Cleanup(func() {
		if svc.State().Party != nil {
			_ = svc.End()
		}
		// Whatever happened, leave nothing of Peli's behind.
		if rows := rows(); len(rows) != 0 {
			if err := c.DeleteProfileSettings(ctx, s, index, nuvio.PlatformPeli); err != nil {
				t.Errorf("removing the announcement: %v", err)
			}
		}
	})

	start := time.Now()
	film := Media{Type: "movie", ID: "tt0000001", Title: "Peli live test"}
	if err := svc.Create(film); err != nil {
		t.Fatal(err)
	}
	code := svc.State().Party.Code
	t.Logf("party created in %v", time.Since(start).Round(time.Millisecond))

	wait := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("%s: not within 20 s", what)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	var announced nuvio.SettingsBlobRow
	wait("the party is announced in the account's synced data", func() bool {
		got := rows()
		if len(got) != 1 || got[0].ProfileID != index {
			return false
		}
		announced = got[0]
		return strings.Contains(string(announced.Settings["party"]), code)
	})
	t.Logf("announced at profile %d in %v", announced.ProfileID, time.Since(start).Round(time.Millisecond))
	if string(announced.Settings["v"]) != "1" {
		t.Errorf("the blob's version = %s, want 1", announced.Settings["v"])
	}

	// The pull another device makes of its own profile's row: the same thing.
	pulled, ok, err := c.ProfileSettings(ctx, s, index, nuvio.PlatformPeli)
	if err != nil || !ok {
		t.Fatalf("pull = %+v, present %v, %v", pulled, ok, err)
	}
	if !strings.Contains(string(pulled.Settings["party"]), code) {
		t.Errorf("the pulled blob has no code in it")
	}
	// And what the list shows is a code that still joins a party, which is
	// what the Join page checks before listing one.
	preview, err := c.PartyPreview(t.Context(), s, code)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Error != "" || preview.Media == nil || preview.Host == nil {
		t.Errorf("preview of the announced code = %+v", preview)
	} else {
		t.Logf("preview: %q hosted by someone, %d of %d seats", mediaTitle(*preview.Media), preview.Members, preview.MaxMembers)
	}

	if err := svc.End(); err != nil {
		t.Fatal(err)
	}
	wait("ending the party clears the announcement", func() bool { return len(rows()) == 0 })
	if got := rows(); len(got) != 0 {
		t.Errorf("the account has %d %q rows after the party", len(got), nuvio.PlatformPeli)
	}
	t.Logf("announcement, listing, preview and withdrawal in %v", time.Since(start).Round(time.Millisecond))
}
