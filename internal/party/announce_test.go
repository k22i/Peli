package party

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// The account's synced data (announce.go, ADR-0067): a party this device
// hosts is announced in it, the listing reads it back, and nothing about it
// can break a party.

func TestAnnounceOnCreate(t *testing.T) {
	r := newRig(t, true)
	// The row is Peli's, but not only the party's: what isn't the party's
	// survives a write.
	r.api.settings = backend.SettingsBlob{
		"v":     json.RawMessage(`1`),
		"other": json.RawMessage(`{"kept":true}`),
	}
	r.playing(120)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party is announced", func() bool {
		an := r.api.announced()
		return an != nil && an.ID == "p1"
	})
	an := r.api.announced()
	if an.Code != "ABCDEF" || an.Profile != 1 || an.Host != "Me" {
		t.Errorf("announcement = %+v", an)
	}
	if an.Media.MetaID != episode.ID || an.Media.Title != episode.Title || an.StartedAt == 0 {
		t.Errorf("what the party watches: %+v", an.Media)
	}
	if string(r.api.settings["other"]) != `{"kept":true}` {
		t.Errorf("the write dropped a key Peli doesn't own: %s", r.api.settings["other"])
	}
}

func TestAnnounceFollowsTheMedia(t *testing.T) {
	r := newRig(t, true)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the episode is announced", func() bool {
		an := r.api.announced()
		return an != nil && an.Media.MetaID == episode.ID
	})
	film := Media{Type: "movie", ID: "tt555", Title: "A film"}
	if err := r.s.SwitchTo(film); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party moving on is announced", func() bool {
		an := r.api.announced()
		return an != nil && an.Media.MetaID == film.ID && an.Media.Title == film.Title
	})
}

func TestWithdrawOnEnd(t *testing.T) {
	r := newRig(t, true)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party is announced", func() bool { return r.api.announced() != nil })
	if err := r.s.End(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "ending it takes the announcement away", func() bool { return r.api.announced() == nil })
}

func TestWithdrawWhenTheChannelHearsTheEnd(t *testing.T) {
	r := newRig(t, true)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party is announced", func() bool { return r.api.announced() != nil })
	// The backend's end arrives on the channel before this device's own End
	// answer: the row goes anyway.
	ch := r.connect(t)
	ended, _ := json.Marshal(map[string]any{"reason": "host_ended"})
	ch.handler.Broadcast("ended", ended)
	eventually(t, "the end on the channel takes the announcement away", func() bool { return r.api.announced() == nil })
}

func TestWithdrawOnLeave(t *testing.T) {
	r := newRig(t, true)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party is announced", func() bool { return r.api.announced() != nil })
	r.s.Leave()
	eventually(t, "leaving takes the announcement away", func() bool { return r.api.announced() == nil })
}

func TestWithdrawWhenHostHandsOn(t *testing.T) {
	r := newRig(t, true)
	if err := r.s.Create(episode); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the party is announced", func() bool { return r.api.announced() != nil })
	r.connect(t)
	// The backend says another member hosts the party now.
	r.api.mu.Lock()
	r.api.answer.Party.HostMemberID = "other"
	r.api.mu.Unlock()
	r.s.mu.Lock()
	sess := r.s.cur
	r.s.mu.Unlock()
	r.s.refreshMembers(sess, "")
	eventually(t, "hosting handed on takes the announcement away", func() bool { return r.api.announced() == nil })
}

func TestAnnounceWhenHostingArrives(t *testing.T) {
	r := newRig(t, false) // joining as a guest
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatal(err)
	}
	if r.api.announced() != nil {
		t.Fatal("a guest announced the party")
	}
	// The host leaves, and the party is this device's to host now.
	r.api.mu.Lock()
	r.api.answer.Party.HostMemberID = "me"
	r.api.mu.Unlock()
	r.s.mu.Lock()
	sess := r.s.cur
	r.s.mu.Unlock()
	r.s.refreshMembers(sess, "")
	eventually(t, "the new host announces the party", func() bool {
		an := r.api.announced()
		return an != nil && an.ID == "p1"
	})
}

func TestAnnouncementNeverBreaksAParty(t *testing.T) {
	r := newRig(t, true)
	r.api.mu.Lock()
	r.api.settingsErr = errors.New("offline")
	r.api.mu.Unlock()
	r.playing(120)
	if err := r.s.Create(episode); err != nil {
		t.Fatalf("a party couldn't start with the announcement failing: %v", err)
	}
	if r.s.State().Party == nil {
		t.Fatal("no party")
	}
	// And joining by code still works, which is what the feature falls back
	// to.
	r.api.mu.Lock()
	r.api.settingsErr = nil
	r.api.mu.Unlock()
	if err := r.s.Join("ABCDEF"); err != nil {
		t.Fatalf("joining by code: %v", err)
	}
}

func TestAccountPartiesDropsStaleAnnouncements(t *testing.T) {
	r := newRig(t, false)
	now := r.time()
	blob := func(id, code string, started time.Time) backend.SettingsBlob {
		raw, _ := json.Marshal(announcedParty{
			ID: id, Code: code, Host: "Kevin", Profile: 1,
			Media:     announcedMedia{Type: "movie", MetaID: "tt1", Title: "Announced"},
			StartedAt: started.UnixMilli(),
		})
		return backend.SettingsBlob{"v": json.RawMessage(`1`), "party": json.RawMessage(raw)}
	}
	r.api.mu.Lock()
	r.api.settings = blob("p1", "AAAAAA", now)
	r.api.settingsUpdated = "2026-11-26T08:30:39.257987+00:00"
	r.api.preview = backend.PartyPreview{
		Media:      &backend.PartyMedia{Type: "movie", MetaID: "tt9", MetaType: "movie", Title: "Live"},
		Host:       &backend.PartyMember{DisplayName: "Kay"},
		Members:    2,
		MaxMembers: 8,
	}
	r.api.mu.Unlock()
	parties := r.s.AccountParties()
	if len(parties) != 1 {
		t.Fatalf("parties = %+v, want the one live party", parties)
	}
	got := parties[0]
	if got.ID != "p1" || got.Code != "AAAAAA" || got.Host != "Kay" || got.Members != 2 || got.Media.Title != "Live" {
		t.Errorf("party = %+v", got)
	}

	// The preview is what says a party ended, whatever the row says.
	r.api.mu.Lock()
	r.api.preview = backend.PartyPreview{Error: backend.PartyNotFound}
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 0 {
		t.Fatalf("parties = %+v, want none: the party is gone", parties)
	}
	eventually(t, "the stale row is deleted", func() bool { return r.api.announced() == nil })

	// And an announcement older than a few hours is stale by itself.
	r.api.mu.Lock()
	r.api.preview = backend.PartyPreview{}
	r.api.settings = blob("p3", "CCCCCC", now.Add(-9*time.Hour))
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 0 {
		t.Fatalf("parties = %+v, want none: the announcement is old", parties)
	}
}

func TestAccountPartiesForAKidsProfile(t *testing.T) {
	r := newRig(t, false)
	r.me.Kids = true
	r.api.settings = backend.SettingsBlob{"v": json.RawMessage(`1`)}
	if parties := r.s.AccountParties(); len(parties) != 0 {
		t.Errorf("a kids profile was listed parties: %+v", parties)
	}
	if r.api.called("preview") {
		t.Error("a kids profile's listing called the backend")
	}
}

func TestAccountPartiesSaysWhenOneIsGone(t *testing.T) {
	r := newRig(t, false)
	raw, _ := json.Marshal(announcedParty{
		ID: "p1", Code: "AAAAAA", Host: "Kevin", Profile: 1,
		Media:     announcedMedia{Type: "movie", MetaID: "tt1", Title: "Announced"},
		StartedAt: r.time().UnixMilli(),
	})
	r.api.mu.Lock()
	r.api.settings = backend.SettingsBlob{"v": json.RawMessage(`1`), "party": json.RawMessage(raw)}
	r.api.settingsUpdated = "2026-11-26T08:30:39.257987+00:00"
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 1 {
		t.Fatalf("parties = %+v", parties)
	}
	// It ends between two fetches: the next one says so.
	r.api.mu.Lock()
	r.api.preview = backend.PartyPreview{Error: backend.PartyEnded}
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 0 {
		t.Fatalf("parties = %+v", parties)
	}
	n := r.notice(t, NoticeGone)
	if n.Media == nil || n.Media.ID != "tt1" {
		t.Errorf("notice = %+v", n)
	}
}

func TestAccountPartiesQuietWhenTheBackendFails(t *testing.T) {
	r := newRig(t, false)
	raw, _ := json.Marshal(announcedParty{
		ID: "p1", Code: "AAAAAA", Host: "Kevin", Profile: 1,
		Media:     announcedMedia{Type: "movie", MetaID: "tt1", Title: "Announced"},
		StartedAt: r.time().UnixMilli(),
	})
	r.api.mu.Lock()
	r.api.settings = backend.SettingsBlob{"v": json.RawMessage(`1`), "party": json.RawMessage(raw)}
	r.api.settingsUpdated = "2026-11-26T08:30:39.257987+00:00"
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 1 {
		t.Fatalf("parties = %+v", parties)
	}
	// Offline: the list is empty, and nothing claims the party ended.
	r.api.mu.Lock()
	r.api.settingsErr = errors.New("offline")
	r.api.mu.Unlock()
	if parties := r.s.AccountParties(); len(parties) != 0 {
		t.Fatalf("parties = %+v", parties)
	}
	select {
	case n := <-r.notices:
		t.Errorf("a read that failed announced %+v", n)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSettingsWith(t *testing.T) {
	an := &announcedParty{ID: "p1", Code: "AAAAAA"}
	row := backend.SettingsBlob{"v": json.RawMessage(`1`), "other": json.RawMessage(`2`), "party": json.RawMessage(`{}`)}
	blob, err := settingsWith(row, an)
	if err != nil {
		t.Fatal(err)
	}
	if got := announcedPartyOf(blob); got == nil || got.ID != "p1" {
		t.Errorf("announcement = %+v", got)
	}
	if string(blob["other"]) != "2" || string(blob["v"]) != "1" {
		t.Errorf("blob = %v", blob)
	}
	// Without a party the key goes and the rest stays.
	blob, err = settingsWith(row, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := blob["party"]; ok {
		t.Errorf("blob still holds a party: %v", blob)
	}
	if keys := slices.Sorted(maps.Keys(blob)); !slices.Equal(keys, []string{"other", "v"}) {
		t.Errorf("keys = %v", keys)
	}
}
