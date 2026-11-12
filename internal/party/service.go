// Package party is Peli's watch party (ADR-0051): watching a film or
// episode in step with friends on Peli or any of Nuvio's apps, each playing
// it from their own streams. Nuvio's backend keeps who is in a party and
// where its playback is; the members tell each other everything else on the
// party's Realtime channel, following the rules in rules.go.
//
// The service follows Peli's player from Go: what the frontend says the
// player shows (Watch), and mpv's own state, every syncEvery. The user's
// pauses, seeks and speed changes reach it through the player's gate
// (player.GateWith) before mpv acts on them, so it can publish them, or
// refuse them while only the host controls playback.
package party

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/playback"
)

func init() {
	application.RegisterEvent[State](EventState)
	application.RegisterEvent[Notice](EventNotice)
	application.RegisterEvent[Chat](EventChat)
}

// API is Nuvio's side of a party: backend.Parties in the app.
type API interface {
	Enabled(ctx context.Context) (bool, error)
	Create(ctx context.Context, id backend.PartyIdentity, media backend.PartyMedia) (backend.PartySnapshot, error)
	Join(ctx context.Context, code string, id backend.PartyIdentity) (backend.PartySnapshot, error)
	Preview(ctx context.Context, code string) (backend.PartyPreview, error)
	Heartbeat(ctx context.Context, partyID, deviceID string) (backend.PartySnapshot, error)
	Update(ctx context.Context, partyID, deviceID string, media *backend.PartyMedia, playback *backend.PartyPlayback) (backend.PartySnapshot, error)
	Leave(ctx context.Context, partyID, deviceID string) (backend.PartySnapshot, error)
	End(ctx context.Context, partyID, deviceID string) (backend.PartySnapshot, error)
	SetHostOnly(ctx context.Context, partyID, deviceID string, hostOnly bool) (backend.PartySnapshot, error)
	RemoveMember(ctx context.Context, partyID, deviceID, memberID string) (backend.PartySnapshot, error)
	SendMessage(ctx context.Context, partyID, deviceID, body, clientID string) (backend.PartyMessageSent, error)
	Messages(ctx context.Context, partyID, deviceID string, after int64) (backend.PartyMessages, error)
	Clock(ctx context.Context) (int64, error)
	Open(partyID, memberID string, handler backend.ChannelHandler) backend.Channel
}

var _ API = backend.Parties{}

// Player is the player as the party drives it: player.Direct in the app,
// whose calls don't go through the gate.
type Player interface {
	Snapshot() playback.State
	SetPaused(paused bool) error
	Seek(position float64) error
	SetSpeed(speed float64) error
}

// Me is who this device is in a party: the profile in use.
type Me struct {
	Identity  backend.PartyIdentity
	ProfileID uint64
	// Linked is true when the profile in use is one of the signed-in
	// account's Nuvio profiles; Kids when it's a kids profile.
	Linked bool
	Kids   bool
}

// Timing, as Nuvio's apps keep it.
const (
	heartbeatEvery  = 2 * time.Minute
	persistAfter    = 1500 * time.Millisecond
	coordinateEvery = 500 * time.Millisecond
	syncEvery       = 250 * time.Millisecond
	resumeGrace     = 3 * time.Second
	waitAtMost      = 15 * time.Second
	clockSamples    = 4
	clockGap        = 400 * time.Millisecond
	statusAfter     = 250 * time.Millisecond
	// How often the backend's switch is read again.
	enabledEvery = 10 * time.Minute
	callWithin   = 15 * time.Second
)

// Party codes: six of these, shown as "ABC DEF".
const (
	codeLength   = 6
	codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	// The longest chat message.
	messageMax = 500
	// The newest messages kept.
	messagesKept = 200
	// What watch_party_list_messages answers at most.
	historyPage = 100
	defaultName = "Peli"
)

// Error is a refusal the frontend reads by Code (MarshalError).
type Error struct{ Code string }

func (e *Error) Error() string { return "party: " + e.Code }

// Error codes, besides the backend's party codes.
const (
	CodeSignIn     = WhySignIn
	CodeKids       = WhyKids
	CodeNetwork    = "network"
	CodeNotInParty = "not_in_party"
	CodeNotHost    = backend.PartyNotHost
	CodeInvalid    = "invalid"
)

// MarshalError gives the frontend a refusal's code.
func MarshalError(err error) []byte {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Code: CodeNetwork}
	}
	data, _ := json.Marshal(map[string]string{"code": e.Code})
	return data
}

// Service is the Wails service for watch parties.
type Service struct {
	api API
	who func() (Me, error)
	now func() time.Time
	// How often the loop and heartbeats run: syncEvery and heartbeatEvery,
	// but for tests, which tick by hand.
	syncEvery, heartbeatEvery time.Duration

	mu        sync.Mutex
	emit      func(name string, data any)
	player    Player
	enabled   bool
	checkedAt time.Time
	checking  bool
	busy      bool
	cur       *session
	// What the player shows, kept between parties: starting one from the
	// player names it, joining one compares with it.
	watching *watch
	chatOpen bool
	// What was emitted last, so a tick that changes nothing sends nothing.
	lastState []byte
}

// watch is what the player shows.
type watch struct {
	media  Media
	stream *Stream
}

// NewService returns a Service calling api, with who as the profile in use.
func NewService(api API, who func() (Me, error)) *Service {
	return &Service{
		api: api, who: who, now: time.Now, enabled: true, emit: func(string, any) {},
		syncEvery: syncEvery, heartbeatEvery: heartbeatEvery,
	}
}

// UsePlayer has the party drive p, the player without its gate. It isn't a
// method, so Wails doesn't bind it.
func UsePlayer(s *Service, p Player) {
	s.mu.Lock()
	s.player = p
	s.mu.Unlock()
}

// ServiceStartup has the service send its events, and reads whether the
// backend has parties on.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.mu.Lock()
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.refreshEnabled()
	s.mu.Unlock()
	return nil
}

// ServiceShutdown leaves the party, so the seat isn't held until it times
// out, and waits a moment for that to go.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	sess := s.cur
	if sess != nil {
		s.stop(sess)
	}
	s.mu.Unlock()
	if sess != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		s.api.Leave(ctx, sess.id, sess.deviceID)
	}
	return nil
}

// State returns the party as it is now.
func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshEnabled()
	return s.state()
}

// unavailable is why parties can't be used now, or "". s.mu is held.
func (s *Service) unavailable() string {
	if !s.enabled {
		return WhyUnavailable
	}
	me, err := s.who()
	switch {
	case err != nil || !me.Linked:
		return WhySignIn
	case me.Kids:
		return WhyKids
	}
	return ""
}

// refreshEnabled reads the backend's switch again once it's due, in the
// background. s.mu is held.
func (s *Service) refreshEnabled() {
	if s.checking || (!s.checkedAt.IsZero() && s.now().Sub(s.checkedAt) < enabledEvery) {
		return
	}
	s.checking = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), callWithin)
		defer cancel()
		enabled, err := s.api.Enabled(ctx)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.checking = false
		if err != nil {
			return // keep what was known; try again next time
		}
		s.checkedAt = s.now()
		s.enabled = enabled
		if !enabled && s.cur != nil {
			s.finish(s.cur, NoticeEnded)
		}
		s.changed()
	}()
}

// Create starts a party watching media, hosted by this device.
func (s *Service) Create(media Media) error {
	if media.ID == "" || media.Type == "" {
		return &Error{Code: CodeInvalid}
	}
	return s.start(func(ctx context.Context, id backend.PartyIdentity) (backend.PartySnapshot, error) {
		return s.api.Create(ctx, id, media.wire())
	})
}

// Join joins the party with code (any case, spaces and dashes ignored).
func (s *Service) Join(code string) error {
	code = NormalizeCode(code)
	if len(code) != codeLength {
		return &Error{Code: backend.PartyNotFound}
	}
	return s.start(func(ctx context.Context, id backend.PartyIdentity) (backend.PartySnapshot, error) {
		return s.api.Join(ctx, code, id)
	})
}

// Preview says what joining code would join, without joining.
func (s *Service) Preview(code string) Preview {
	code = NormalizeCode(code)
	if len(code) != codeLength {
		return Preview{Error: backend.PartyNotFound}
	}
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	p, err := s.api.Preview(ctx, code)
	if err != nil {
		return Preview{Error: CodeNetwork}
	}
	out := Preview{Error: p.Error, Members: p.Members, MaxMembers: p.MaxMembers}
	if p.Media != nil {
		media := mediaOf(*p.Media)
		out.Media = &media
	}
	if p.Host != nil {
		out.Host = p.Host.DisplayName
	}
	return out
}

// NormalizeCode keeps the letters and digits a code can have, upper case.
func NormalizeCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if strings.ContainsRune(codeAlphabet, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (s *Service) start(request func(context.Context, backend.PartyIdentity) (backend.PartySnapshot, error)) error {
	s.mu.Lock()
	if why := s.unavailable(); why != "" {
		s.mu.Unlock()
		return &Error{Code: why}
	}
	if s.busy {
		s.mu.Unlock()
		return &Error{Code: backend.PartyRateLimited}
	}
	me, err := s.who()
	if err != nil {
		s.mu.Unlock()
		return &Error{Code: CodeSignIn}
	}
	s.busy = true
	s.changed()
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	sentAt := s.now()
	snap, err := request(ctx, me.Identity)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.busy = false
	defer s.changed()
	switch {
	case errors.Is(err, backend.ErrSignedOut):
		return &Error{Code: CodeSignIn}
	case err != nil:
		slog.Warn("watch party request failed", "err", err)
		return &Error{Code: CodeNetwork}
	case snap.Error != "":
		if snap.Error == backend.PartyUnavailable {
			s.enabled = false
		}
		return &Error{Code: snap.Error}
	case snap.Party == nil || snap.MemberID == "":
		return &Error{Code: CodeNetwork}
	}
	if s.cur != nil {
		old := s.cur
		s.stop(old)
		go s.api.Leave(context.Background(), old.id, old.deviceID)
	}
	s.begin(snap, me, sentAt, nil)
	return nil
}

// Leave leaves the party; a host leaving hands it to another member.
func (s *Service) Leave() {
	s.mu.Lock()
	sess := s.cur
	if sess == nil {
		s.mu.Unlock()
		return
	}
	s.stop(sess)
	s.changed()
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	if _, err := s.api.Leave(ctx, sess.id, sess.deviceID); err != nil {
		slog.Warn("leaving watch party failed", "err", err)
	}
}

// End ends the party for everyone (the host only).
func (s *Service) End() error {
	sess, err := s.hosting()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	snap, err := s.api.End(ctx, sess.id, sess.deviceID)
	if err != nil {
		return &Error{Code: CodeNetwork}
	}
	if snap.Error != "" && snap.Error != backend.PartyEnded {
		return &Error{Code: snap.Error}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == sess {
		s.stop(sess)
		s.changed()
	}
	return nil
}

// SetHostOnly lets only the host control playback, or everyone (the host
// only).
func (s *Service) SetHostOnly(on bool) error {
	sess, err := s.hosting()
	if err != nil {
		return err
	}
	s.mu.Lock()
	was := sess.hostOnly
	sess.hostOnly = on
	s.changed()
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	snap, err := s.api.SetHostOnly(ctx, sess.id, sess.deviceID, on)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != sess {
		return nil
	}
	if err != nil || snap.Party == nil {
		sess.hostOnly = was
		s.changed()
		if err != nil {
			return &Error{Code: CodeNetwork}
		}
		return &Error{Code: cmpOr(snap.Error, CodeNetwork)}
	}
	s.applySnapshot(sess, snap)
	return nil
}

// RemoveMember removes memberID from the party for good (the host only).
func (s *Service) RemoveMember(memberID string) error {
	sess, err := s.hosting()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), callWithin)
	defer cancel()
	snap, err := s.api.RemoveMember(ctx, sess.id, sess.deviceID, memberID)
	if err != nil {
		return &Error{Code: CodeNetwork}
	}
	if snap.Error != "" {
		return &Error{Code: snap.Error}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == sess {
		s.applySnapshot(sess, snap)
	}
	return nil
}

// SetSharing shares the host's stream with the others, or stops (the host
// only). The stream is the one Watch names, while it's a link others can
// open.
func (s *Service) SetSharing(on bool) error {
	sess, err := s.hosting()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != sess || sess.sharing == on {
		return nil
	}
	sess.sharing = on
	// The next tick sends the stream; stopping sends none at once.
	sess.sync.lastShared = "-"
	if !on {
		s.sendStream(sess, nil)
	}
	s.changed()
	return nil
}

// SwitchTo moves the party to media, from the start (the host only): for a
// host who opened another title. The host's player moving straight on to
// another file (the next episode) moves the party by itself.
func (s *Service) SwitchTo(media Media) error {
	if media.ID == "" || media.Type == "" {
		return &Error{Code: CodeInvalid}
	}
	sess, err := s.hosting()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != sess {
		return nil
	}
	position := int64(0)
	if s.watching != nil && s.watching.media.Key() == media.Key() && s.player != nil {
		if st := s.player.Snapshot(); st.Active {
			position = ms(st.Position)
		}
	}
	s.publishMedia(sess, media, position)
	sess.sync.prevKey = media.Key()
	sess.sync.lastSeq = ""
	s.changed()
	return nil
}

// CatchUp brings this member, watching behind, back in step.
func (s *Service) CatchUp() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.cur; sess != nil {
		s.setBehind(sess, false)
		s.changed()
	}
}

// Watch says what the player shows: media, playing stream (nil when it
// isn't a link others could open), or nil media when the player shows
// nothing (it left, or the file failed).
func (s *Service) Watch(media *Media, stream *Stream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if media == nil {
		if s.watching != nil && s.cur != nil {
			s.leavePlayback(s.cur)
		}
		s.watching = nil
		s.changed()
		return
	}
	w := &watch{media: *media}
	if stream != nil && shareable(stream.URL) {
		copied := *stream
		w.stream = &copied
	}
	s.watching = w
	s.changed()
}

// StartAt is where the party's playback of media is now, in seconds: where
// a member who joins it starts. It's -1 when the party has no playback of
// media.
func (s *Service) StartAt(media Media) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.cur
	if sess == nil || sess.playback == nil || media.Key() != sess.media.Key() ||
		sess.playback.MediaKey != "" && sess.playback.MediaKey != media.Key() {
		return -1
	}
	return float64(expectedPosition(*sess.playback, sess.clock.nowMs(), 0)) / 1000
}

// hosting returns the party while this device hosts it.
func (s *Service) hosting() (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.cur
	switch {
	case sess == nil:
		return nil, &Error{Code: CodeNotInParty}
	case sess.memberID != sess.hostID:
		return nil, &Error{Code: CodeNotHost}
	}
	return sess, nil
}

// changed sends the state if it changed. s.mu is held.
func (s *Service) changed() {
	state := s.state()
	data, _ := json.Marshal(state)
	if string(data) == string(s.lastState) {
		return
	}
	s.lastState = data
	s.emit(EventState, state)
}

// notify tells the frontend n. s.mu is held.
func (s *Service) notify(n Notice) { s.emit(EventNotice, n) }

// state is the party as the frontend shows it. s.mu is held.
func (s *Service) state() State {
	out := State{Unavailable: s.unavailable(), Busy: s.busy}
	sess := s.cur
	if sess == nil {
		return out
	}
	key := sess.media.Key()
	p := &Party{
		ID: sess.id, Code: sess.code, MemberID: sess.memberID, HostID: sess.hostID,
		IsHost: sess.isHost(), HostOnly: sess.hostOnly, CanControl: sess.canControl(),
		Connected: sess.connected, MaxMembers: sess.maxMembers, Media: mediaOf(sess.media),
		Watching: s.watching != nil && s.watching.media.Key() == key,
		Behind:   sess.behind, BehindMs: sess.behindMs, Sharing: sess.sharing,
		Members: []Member{}, WaitingFor: []string{},
	}
	if pb := sess.playback; pb != nil {
		p.Paused, p.Waiting = pb.Paused, pb.Waiting
		if pb.Waiting {
			for _, id := range waitingMembers(sess.presence, key, sess.ignored) {
				if m := sess.member(id); m != nil {
					p.WaitingFor = append(p.WaitingFor, m.DisplayName)
				}
			}
		}
	}
	if sh := sess.shared; sh != nil && !sess.isHost() && sh.MediaKey == key {
		shared := *sh
		if host := sess.member(sess.hostID); host != nil {
			shared.SharedBy = host.DisplayName
		}
		p.Shared = &shared
	}
	for _, m := range sess.members {
		view := Member{
			ID: m.ID, Name: m.DisplayName, AvatarURL: m.AvatarURL, AvatarColor: m.AvatarColor,
			Host: m.ID == sess.hostID, You: m.ID == sess.memberID, Status: StatusOffline,
		}
		if presence, ok := sess.presence[m.ID]; ok {
			view.Status = cmpOr(presence.Status, StatusBrowsing)
			view.WatchingElse = presence.MediaKey != "" && presence.MediaKey != key
			view.BehindMs = presence.BehindMs
		} else if view.You {
			view.Status = StatusBrowsing
		}
		p.Members = append(p.Members, view)
	}
	out.Party = p
	return out
}
