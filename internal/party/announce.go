package party

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// Announcing a party in the account's synced data (ADR-0067).
//
// Nuvio has no call that lists an account's parties, and watch_party_join
// needs the code, so a profile can't see a party another profile of the same
// account hosts. Nuvio's realtime server refuses every account-scoped channel
// (spikes/party-account-topic/REPORT.md), so Peli announces the party itself,
// in the settings blob of the account's synced data, under a platform key
// Nuvio's clients never ask for: every profile of the account reads it, and
// the Join page joins with one click.
//
// The announcement is a courtesy, never a condition. Everything here is
// best-effort and runs off the party's own goroutines and outside the
// playback path: a failure is logged and forgotten, and typing a code still
// works, so the feature degrades to what Peli did before it.

const (
	// announceVersion is the blob's own version, so a later Peli can read an
	// older one.
	announceVersion = 1
	// announceMaxAge is how old an announcement may be. A host that crashed
	// leaves its row behind and nothing on the server sweeps it.
	announceMaxAge = 8 * time.Hour
	// announceRetry is how long to wait before reading the row again after
	// a conflict: the other writer's request has long finished.
	announceRetry = 200 * time.Millisecond
	// The two keys of the blob Peli owns, which is the whole of it:
	// {"v":1,"party":{…}}, and {"v":1} while nothing is announced.
	keyVersion = "v"
	keyParty   = "party"
)

// announcedParty is the party as it is announced.
type announcedParty struct {
	ID        string         `json:"id"`
	Code      string         `json:"code"`
	Host      string         `json:"host"`
	Profile   int            `json:"profile"`
	Media     announcedMedia `json:"media"`
	StartedAt int64          `json:"started_at"`
}

// announcedMedia is what the party watches, as the list shows it before a
// preview answers.
type announcedMedia struct {
	Type    string `json:"type"`
	MetaID  string `json:"meta_id"`
	Title   string `json:"title"`
	Season  *int   `json:"season,omitempty"`
	Episode *int   `json:"episode,omitempty"`
	Poster  string `json:"poster,omitempty"`
}

// AccountParty is one of the account's live parties, as the Join page lists
// it: from the announcement, confirmed by what watch_party_preview says its
// code joins.
type AccountParty struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	Host    string `json:"host"`
	Profile int    `json:"profile"`
	// Media is what's playing, from the preview where it answered, else from
	// the announcement.
	Media      Media `json:"media"`
	Members    int   `json:"members"`
	MaxMembers int   `json:"maxMembers"`
	StartedAt  int64 `json:"startedAt"`
}

// announce writes the party into the account's synced data, in the
// background. s.mu is held.
func (s *Service) announce(sess *session, media Media) {
	profile, ok := profileIndex(sess.identity)
	if !ok {
		return
	}
	host := sess.identity.DisplayName
	if m := sess.member(sess.memberID); m != nil && m.DisplayName != "" {
		host = m.DisplayName
	}
	an := announcedParty{
		ID: sess.id, Code: sess.code, Host: host, Profile: profile,
		Media: announcedMedia{
			Type: media.Type, MetaID: media.ID, Title: media.Title,
			Season: media.Season, Episode: media.Episode, Poster: media.Poster,
		},
		StartedAt: sess.startedAt,
	}
	s.announced = sess.id
	s.announceToken++
	go s.writeAnnouncement(profile, an)
}

// hostingMoved takes the announcement with the party: a device that hosts
// now announces it, and one that no longer hosts takes its own away. s.mu is
// held.
func (s *Service) hostingMoved(sess *session) {
	if sess.isHost() {
		s.announce(sess, mediaOf(sess.media))
		return
	}
	s.withdraw(sess)
}

// withdraw takes the announcement away, if this device wrote one for sess.
// s.mu is held.
func (s *Service) withdraw(sess *session) {
	if s.announced == "" || s.announced != sess.id {
		return
	}
	s.announced = ""
	s.announceToken++
	profile, ok := profileIndex(sess.identity)
	if !ok {
		return
	}
	go s.clearAnnouncement(profile, sess.id, s.announceToken)
}

// listedAgain records the parties a fetch listed and announces those that
// were listed before and are gone now: they ended while the Join page was
// open. s.mu is held.
func (s *Service) listedAgain(parties []AccountParty) {
	now := map[string]AccountParty{}
	for _, p := range parties {
		now[p.ID] = p
	}
	for id, gone := range s.listed {
		if _, still := now[id]; still {
			continue
		}
		media := gone.Media
		s.notify(Notice{Kind: NoticeGone, Media: &media})
	}
	s.listed = now
	s.changed()
}

// announceCurrent reports whether token is still the newest announcement
// change.
func (s *Service) announceCurrent(token int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.announceToken == token
}

// profileIndex is the Nuvio profile an identity joined with.
func profileIndex(id backend.PartyIdentity) (int, bool) {
	if id.ProfileIndex == nil || *id.ProfileIndex < 1 {
		return 0, false
	}
	return *id.ProfileIndex, true
}

// writeAnnouncement puts an in the account's synced data, and logs a refusal
// rather than telling anyone: no one is waiting for it.
func (s *Service) writeAnnouncement(profile int, an announcedParty) {
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	if err := s.putAnnouncement(ctx, profile, &an); err != nil {
		slog.Debug("announcing the watch party failed", "err", err)
	}
}

// putAnnouncement writes an into the row, reading it again and trying once
// more after a conflict. The row is replaced whole, so what Peli doesn't own
// is copied back.
func (s *Service) putAnnouncement(ctx context.Context, profile int, an *announcedParty) error {
	row, ok, err := s.api.AccountSettings(ctx, profile, backend.AnnouncePlatform)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		blob, err := settingsWith(row.Settings, an)
		if err != nil {
			return err
		}
		if ok && row.UpdatedAt != "" {
			// Compare-and-set, so two Peli clients can't clobber each
			// other's row.
			_, err = s.api.PutAccountSettingsGuarded(ctx, profile, backend.AnnouncePlatform, blob, row.UpdatedAt)
		} else {
			err = s.api.PutAccountSettings(ctx, profile, backend.AnnouncePlatform, blob)
		}
		if err == nil || attempt > 0 {
			return err
		}
		// A conflict: another client wrote the row in between.
		if sleep(ctx, announceRetry) != nil {
			return err
		}
		if row, ok, err = s.api.AccountSettings(ctx, profile, backend.AnnouncePlatform); err != nil {
			return err
		}
	}
}

// clearAnnouncement removes the party from the row it was announced in, if
// it is still there. token is the announcement change it belongs to: a party
// announced again since (a seat taken back, say) keeps its row.
func (s *Service) clearAnnouncement(profile int, partyID string, token int) {
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	row, ok, err := s.api.AccountSettings(ctx, profile, backend.AnnouncePlatform)
	if err != nil || !ok {
		return
	}
	an := announcedPartyOf(row.Settings)
	if an == nil || an.ID != partyID {
		return // another device's announcement, or gone already
	}
	if !s.announceCurrent(token) {
		return
	}
	s.clearRow(ctx, profile, row)
}

// clearRow takes the party out of row. The row is Peli's, but not only the
// party's: while it holds anything else the party key goes and the row stays,
// and only a row that held nothing else is deleted.
func (s *Service) clearRow(ctx context.Context, profile int, row backend.SettingsBlobRow) {
	blob, err := settingsWith(row.Settings, nil)
	if err != nil {
		return
	}
	if len(blob) == 1 { // just the version: nothing else of Peli's
		if err := s.api.ClearAccountSettings(ctx, profile, backend.AnnouncePlatform); err != nil {
			slog.Debug("withdrawing the watch party's announcement failed", "err", err)
		}
		return
	}
	if row.UpdatedAt != "" {
		if _, err := s.api.PutAccountSettingsGuarded(ctx, profile, backend.AnnouncePlatform, blob, row.UpdatedAt); err == nil {
			return
		}
	}
	if err := s.api.PutAccountSettings(ctx, profile, backend.AnnouncePlatform, blob); err != nil {
		slog.Debug("leaving the watch party's row behind", "err", err)
	}
}

// accountParties lists the account's live parties: every announcement, then
// what each code's preview says, which is what's authoritative. A row whose
// party is gone is deleted on the way past. It runs without the lock: only
// the backend and the clock are read. ok is false when the account couldn't
// be read at all, which says nothing about any party.
func (s *Service) accountParties(ctx context.Context) (parties []AccountParty, ok bool) {
	rows, err := s.api.AccountSettingsList(ctx, backend.AnnouncePlatform)
	if err != nil {
		return nil, false // offline, or refusing: the Join page shows nothing
	}
	now := s.now().UnixMilli()
	fresh := func(an announcedParty) bool {
		return an.StartedAt <= 0 || now-an.StartedAt <= announceMaxAge.Milliseconds()
	}
	candidates := []announcedParty{}
	profiles := []int{}
	for _, row := range rows {
		an := announcedPartyOf(row.Settings)
		if an == nil || an.ID == "" || an.Code == "" {
			continue
		}
		candidates = append(candidates, *an)
		profiles = append(profiles, row.ProfileID)
	}
	// One preview each, all at once: a handful of calls, and every one of
	// them says whether the party is still there.
	found := make([]AccountParty, len(candidates))
	alive := make([]bool, len(candidates))
	var wg sync.WaitGroup
	for i := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			found[i], alive[i] = s.confirmParty(ctx, candidates[i], fresh(candidates[i]))
		}()
	}
	wg.Wait()
	out := []AccountParty{}
	for i := range found {
		if alive[i] {
			out = append(out, found[i])
			continue
		}
		go s.forgetAnnouncement(profiles[i], candidates[i].ID)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return dedupeByParty(out), true
}

// confirmParty asks what an announced code joins, for the party it belongs
// to, and whether the announcement is still true. fresh is the age check:
// an announcement old enough is dead whatever the backend says.
func (s *Service) confirmParty(ctx context.Context, an announcedParty, fresh bool) (AccountParty, bool) {
	out := AccountParty{
		ID: an.ID, Code: an.Code, Host: an.Host, Profile: an.Profile, StartedAt: an.StartedAt,
		Media: Media{
			Type: an.Media.Type, ID: an.Media.MetaID, Title: an.Media.Title,
			Season: an.Media.Season, Episode: an.Media.Episode, Poster: an.Media.Poster,
		},
	}
	if !fresh {
		return out, false
	}
	p, err := s.api.Preview(ctx, an.Code)
	if err != nil {
		// A call that failed says nothing about the party: it stays until
		// its age settles it.
		return out, true
	}
	switch p.Error {
	case backend.PartyNotFound, backend.PartyEnded:
		return out, false // the party is over, and the row is stale
	}
	// Anything else ("", full, unavailable) says the party is still there:
	// what the preview knows fills the listing.
	if p.Media != nil {
		out.Media = mediaOf(*p.Media)
	}
	if p.Host != nil && p.Host.DisplayName != "" {
		out.Host = p.Host.DisplayName
	}
	out.Members, out.MaxMembers = p.Members, p.MaxMembers
	return out, true
}

// forgetAnnouncement drops an announcement whose party is gone, best-effort:
// the next read sweeps it again if this one fails.
func (s *Service) forgetAnnouncement(profile int, partyID string) {
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	row, ok, err := s.api.AccountSettings(ctx, profile, backend.AnnouncePlatform)
	if err != nil || !ok {
		return
	}
	if an := announcedPartyOf(row.Settings); an == nil || an.ID != partyID {
		return
	}
	s.clearRow(ctx, profile, row)
}

// settingsWith returns row's blob with an as its party, or without one for
// nil. The keys Peli doesn't own are copied back untouched: the row is
// replaced whole.
func settingsWith(row backend.SettingsBlob, an *announcedParty) (backend.SettingsBlob, error) {
	blob := backend.SettingsBlob{keyVersion: json.RawMessage(strconv.Itoa(announceVersion))}
	for k, v := range row {
		switch k {
		case keyParty:
			continue // Peli's, and about to be set
		default:
			blob[k] = v
		}
	}
	if an == nil {
		return blob, nil
	}
	raw, err := json.Marshal(an)
	if err != nil {
		return nil, err
	}
	blob[keyParty] = json.RawMessage(raw)
	return blob, nil
}

// announcedPartyOf is the announcement in a blob, or nil.
func announcedPartyOf(blob backend.SettingsBlob) *announcedParty {
	raw, ok := blob[keyParty]
	if !ok {
		return nil
	}
	var an announcedParty
	if err := json.Unmarshal(raw, &an); err != nil {
		return nil
	}
	return &an
}

// dedupeByParty keeps one listing per party, the one showing the most
// members: the same party announced by two profiles is still one party.
func dedupeByParty(parties []AccountParty) []AccountParty {
	seen := map[string]int{}
	out := parties[:0]
	for _, p := range parties {
		if i, ok := seen[p.ID]; ok {
			if p.Members > out[i].Members {
				out[i] = p
			}
			continue
		}
		seen[p.ID] = len(out)
		out = append(out, p)
	}
	return out
}
