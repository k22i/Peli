package party

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// session is one party this device is in, from joining until it leaves.
// Everything in it is read and written with Service.mu held.
type session struct {
	ctx     context.Context
	cancel  context.CancelFunc
	channel backend.Channel
	// Frames for the channel, sent one at a time in order, off the lock.
	out   chan func()
	clock *clock

	id, code, memberID, hostID string
	deviceID                   string
	identity                   backend.PartyIdentity
	profileID                  uint64
	members                    []backend.PartyMember
	// Who is on the channel, by member id, with what they last said.
	presence   map[string]presenceState
	media      backend.PartyMedia
	maxMembers int
	connected  bool
	hostOnly   bool
	sharing    bool
	playback   *backend.PartyPlayback
	// The host's shared stream: sent (the host) or received (the others).
	shared *Stream
	// This member's own status, and when it goes out.
	local       *presenceState
	statusTimer *time.Timer
	persist     *time.Timer
	// Members the party stopped waiting for, until they're ready again.
	ignored     map[string]bool
	waitStarted time.Time
	resumedAt   time.Time
	rejoining   bool
	// away: the app is in the background and the channel is closed on
	// purpose (suspend.go); the seat is kept.
	away bool

	// Watching on alone, behind the party (only-the-host parties).
	behind   bool
	behindMs int64
	// The rate the player was nudged to, or 0.
	nudged float64
	sync   syncState
	chat   chatState
	// The reaction rate limits.
	reactions reactionState
}

func (sess *session) isHost() bool { return sess.memberID == sess.hostID }

func (sess *session) canControl() bool { return !sess.hostOnly || sess.isHost() }

func (sess *session) member(id string) *backend.PartyMember {
	for i := range sess.members {
		if sess.members[i].ID == id {
			return &sess.members[i]
		}
	}
	return nil
}

// send queues a broadcast; it's dropped if the channel isn't joined.
func (sess *session) send(event string, payload any) {
	sess.queue(func() {
		if err := sess.channel.Send(event, payload); err != nil && !errors.Is(err, errNotJoined) {
			slog.Debug("watch party send failed", "event", event, "err", err)
		}
	})
}

func (sess *session) track(payload any) {
	sess.queue(func() { _ = sess.channel.Track(payload) })
}

func (sess *session) queue(f func()) {
	select {
	case sess.out <- f:
	default: // a stalled connection: drop rather than block the party
	}
}

// begin starts a session from a create or join answer, asked for at
// sentAt, with playback carried over from a session it replaces. s.mu is
// held.
func (s *Service) begin(snap backend.PartySnapshot, me Me, sentAt time.Time, playback *backend.PartyPlayback) {
	ctx, cancel := context.WithCancel(context.Background())
	info := snap.Party
	sess := &session{
		ctx: ctx, cancel: cancel, out: make(chan func(), 64), clock: newClock(s.now),
		id: info.ID, code: info.Code, memberID: snap.MemberID, hostID: info.HostMemberID,
		deviceID: me.Identity.DeviceID, identity: me.Identity, profileID: me.ProfileID,
		members: snap.Members, presence: map[string]presenceState{}, media: info.Media,
		maxMembers: info.MaxMembers, hostOnly: info.HostOnly, ignored: map[string]bool{},
	}
	if snap.ServerTimeMs > 0 {
		sess.clock.add(snap.ServerTimeMs, sentAt)
	}
	if playback == nil {
		playback = info.Playback
	}
	if playback != nil && (playback.MediaKey == "" || playback.MediaKey == info.Media.Key()) {
		copied := *playback
		sess.playback = &copied
	}
	s.cur = sess
	s.chatOpen = false
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case f := <-sess.out:
				f()
			}
		}
	}()
	sess.channel = s.openChannel(sess)
	go s.heartbeats(sess)
	go s.refineClock(sess)
	go s.loop(sess)
	s.syncChat(sess, false)
	s.emitChat(sess)
}

// openChannel opens sess's Realtime channel, whose callbacks run for sess
// while it's still the party.
func (s *Service) openChannel(sess *session) backend.Channel {
	return s.api.Open(sess.id, sess.memberID, backend.ChannelHandler{
		Broadcast: func(event string, payload json.RawMessage) {
			s.locked(sess, func() { s.onMessage(sess, event, payload) })
		},
		Presence: func(joins, leaves map[string]json.RawMessage) {
			s.locked(sess, func() { s.onPresence(sess, joins, leaves) })
		},
		Connected: func(on bool) { s.locked(sess, func() { s.onConnected(sess, on) }) },
	})
}

// locked runs f with s.mu held while sess is still the party, then sends
// the state if it changed.
func (s *Service) locked(sess *session, f func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != sess {
		return
	}
	f()
	s.changed()
}

// stop ends the session on this device. s.mu is held.
func (s *Service) stop(sess *session) {
	if s.cur != sess {
		return
	}
	s.cur = nil
	sess.cancel()
	if sess.persist != nil {
		sess.persist.Stop()
	}
	if sess.statusTimer != nil {
		sess.statusTimer.Stop()
	}
	if sess.nudged != 0 && s.player != nil && s.watching != nil {
		_ = s.player.SetSpeed(rate(orZero(sess.playback)))
	}
	// Close waits for the channel's goroutine, which may be waiting for
	// s.mu.
	go sess.channel.Close()
	s.emit(EventChat, Chat{Messages: []Message{}})
}

// finish ends the session and says why. s.mu is held.
func (s *Service) finish(sess *session, kind string) {
	s.stop(sess)
	s.notify(Notice{Kind: kind})
	s.changed()
}

func orZero(p *backend.PartyPlayback) backend.PartyPlayback {
	if p == nil {
		return backend.PartyPlayback{Rate: 1}
	}
	return *p
}

func (s *Service) onConnected(sess *session, on bool) {
	sess.connected = on
	if !on {
		for id := range sess.presence {
			if id != sess.memberID {
				delete(sess.presence, id)
			}
		}
		return
	}
	own := s.ownPresence(sess)
	sess.track(own)
	sess.send("status", own)
	if sess.playback != nil {
		sess.send("state", *sess.playback)
	}
	if sess.isHost() && sess.sharing && sess.shared != nil {
		s.sendStream(sess, sess.shared)
	}
	sess.send("state_request", map[string]string{"member_id": sess.memberID})
	s.syncChat(sess, true)
}

func (s *Service) ownPresence(sess *session) presenceState {
	if sess.local != nil {
		return *sess.local
	}
	return presenceState{MemberID: sess.memberID, Status: StatusBrowsing}
}

func (s *Service) onMessage(sess *session, event string, payload json.RawMessage) {
	var fields struct {
		MemberID     string          `json:"member_id"`
		Reason       string          `json:"reason"`
		HostMemberID string          `json:"host_member_id"`
		HostOnly     *bool           `json:"host_only"`
		Media        json.RawMessage `json:"media"`
		Playback     json.RawMessage `json:"playback"`
		Stream       json.RawMessage `json:"stream"`
	}
	json.Unmarshal(payload, &fields)
	switch event {
	case "state":
		var p backend.PartyPlayback
		if json.Unmarshal(payload, &p) == nil {
			s.accept(sess, p)
		}
	case "state_request":
		if fields.MemberID == sess.memberID {
			return
		}
		sess.send("status", s.ownPresence(sess))
		if sess.isHost() && sess.sharing && sess.shared != nil {
			s.sendStream(sess, sess.shared)
		}
		if sess.playback != nil {
			sess.send("state", *sess.playback)
		}
	case "status":
		var p presenceState
		if json.Unmarshal(payload, &p) == nil && p.MemberID != "" && p.MemberID != sess.memberID {
			if p.Status == StatusReady {
				delete(sess.ignored, p.MemberID)
			}
			sess.presence[p.MemberID] = p
		}
	case "control":
		if fields.HostOnly == nil || *fields.HostOnly == sess.hostOnly {
			return
		}
		sess.hostOnly = *fields.HostOnly
		if !sess.isHost() {
			s.notify(Notice{Kind: NoticeControl, HostOnly: sess.hostOnly})
		}
	case "member_joined":
		go s.refreshMembers(sess, fields.MemberID)
	case "member_left":
		s.onMemberLeft(sess, fields.MemberID, fields.Reason, fields.HostMemberID)
	case "ended":
		if fields.Reason == "disabled" {
			s.enabled = false
		}
		s.finish(sess, NoticeEnded)
	case "media":
		var media backend.PartyMedia
		if json.Unmarshal(fields.Media, &media) != nil {
			return
		}
		var playback *backend.PartyPlayback
		if len(fields.Playback) > 0 && string(fields.Playback) != "null" {
			var p backend.PartyPlayback
			if json.Unmarshal(fields.Playback, &p) == nil {
				playback = &p
			}
		}
		s.applyMedia(sess, media, playback)
	case "stream":
		if sess.isHost() || fields.MemberID != sess.hostID {
			return
		}
		sess.shared = nil
		var w wireStream
		if len(fields.Stream) > 0 && string(fields.Stream) != "null" && json.Unmarshal(fields.Stream, &w) == nil && shareable(w.URL) {
			stream := streamOf(w)
			sess.shared = &stream
		}
	case "reaction":
		s.onReaction(sess, payload)
	case "chat":
		var m backend.PartyMessage
		if json.Unmarshal(payload, &m) == nil {
			s.mergeChat(sess, []backend.PartyMessage{m}, false, true)
		}
	}
}

func (s *Service) onPresence(sess *session, joins, leaves map[string]json.RawMessage) {
	left := false
	for id := range leaves {
		if _, back := joins[id]; id != sess.memberID && !back {
			delete(sess.presence, id)
			left = true
		}
	}
	for id, data := range joins {
		if _, known := sess.presence[id]; id == sess.memberID || known {
			continue
		}
		var p presenceState
		json.Unmarshal(data, &p)
		p.MemberID = id
		sess.presence[id] = p
		if p.Status == StatusReady {
			delete(sess.ignored, id)
		}
	}
	if left {
		sess.send("state_request", map[string]string{"member_id": sess.memberID})
	}
}

func (s *Service) onMemberLeft(sess *session, memberID, reason, hostID string) {
	if memberID == "" {
		return
	}
	if memberID == sess.memberID {
		if reason == "removed" {
			s.finish(sess, NoticeRemoved)
		} else {
			s.rejoinOrFinish(sess)
		}
		return
	}
	name := ""
	if m := sess.member(memberID); m != nil {
		name = m.DisplayName
	}
	if memberID == sess.hostID {
		sess.shared = nil
	}
	members := sess.members[:0:0]
	for _, m := range sess.members {
		if m.ID != memberID {
			members = append(members, m)
		}
	}
	sess.members = members
	delete(sess.presence, memberID)
	delete(sess.ignored, memberID)
	if hostID != "" {
		sess.hostID = hostID
	}
	if name != "" {
		s.notify(Notice{Kind: NoticeLeft, Name: name})
	}
}

// refreshMembers reads the members again, after someone joined, and
// announces them.
func (s *Service) refreshMembers(sess *session, announce string) {
	snap, err := s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
		return s.api.Heartbeat(ctx, sess.id, sess.deviceID)
	})
	s.locked(sess, func() {
		if err != nil {
			return
		}
		s.applySnapshot(sess, snap)
		if m := sess.member(announce); m != nil && announce != sess.memberID && s.cur == sess {
			s.notify(Notice{Kind: NoticeJoined, Name: m.DisplayName})
		}
	})
}

// call runs a backend call for sess, off the lock.
func (s *Service) call(sess *session, fn func(ctx context.Context) (backend.PartySnapshot, error)) (backend.PartySnapshot, error) {
	ctx, cancel := context.WithTimeout(sess.ctx, callWithin)
	defer cancel()
	snap, err := fn(ctx)
	if err != nil && sess.ctx.Err() == nil {
		slog.Warn("watch party call failed", "err", err)
	}
	return snap, err
}

// applySnapshot takes in what a party function answered. s.mu is held.
func (s *Service) applySnapshot(sess *session, snap backend.PartySnapshot) {
	switch snap.Error {
	case "":
	case backend.PartyNotMember:
		s.rejoinOrFinish(sess)
		return
	case backend.PartyEnded:
		s.finish(sess, NoticeEnded)
		return
	default:
		return
	}
	info := snap.Party
	if info == nil {
		return
	}
	sess.members = snap.Members
	sess.hostID = info.HostMemberID
	sess.maxMembers = info.MaxMembers
	sess.hostOnly = info.HostOnly
	for id := range sess.presence {
		if sess.member(id) == nil {
			delete(sess.presence, id)
		}
	}
	if info.Media.Key() != sess.media.Key() {
		s.applyMedia(sess, info.Media, info.Playback)
	} else if info.Playback != nil {
		s.accept(sess, *info.Playback)
	}
}

// applyMedia takes in what the party watches now. s.mu is held.
func (s *Service) applyMedia(sess *session, media backend.PartyMedia, playback *backend.PartyPlayback) {
	changed := media.Key() != sess.media.Key()
	sess.media = media
	if !changed {
		if playback != nil {
			s.accept(sess, *playback)
		}
		return
	}
	sess.playback = nil
	if playback != nil && (playback.MediaKey == "" || playback.MediaKey == media.Key()) {
		copied := *playback
		sess.playback = &copied
	}
	if sess.shared != nil && sess.shared.MediaKey != media.Key() {
		sess.shared = nil
	}
	sess.ignored = map[string]bool{}
	sess.waitStarted = time.Time{}
	view := mediaOf(media)
	s.notify(Notice{Kind: NoticeMedia, Media: &view})
}

// accept takes in a playback another member (or the backend) sent, if it's
// newer than the one held. s.mu is held.
func (s *Service) accept(sess *session, candidate backend.PartyPlayback) {
	if candidate.MediaKey != "" && candidate.MediaKey != sess.media.Key() {
		return
	}
	if sess.hostOnly && candidate.MemberID != sess.hostID {
		return
	}
	current := sess.playback
	if !newer(candidate, current) {
		return
	}
	if current != nil && current.Paused && !candidate.Paused {
		sess.resumedAt = s.now()
		if current.Waiting {
			for _, id := range waitingMembers(sess.presence, sess.media.Key(), nil) {
				sess.ignored[id] = true
			}
		}
	}
	sess.playback = &candidate
	if candidate.MemberID == sess.memberID {
		return
	}
	action := actionOf(current, candidate)
	m := sess.member(candidate.MemberID)
	if action == "" || m == nil {
		return
	}
	s.notify(Notice{Kind: NoticeAction, Name: m.DisplayName, Action: action, PositionMs: candidate.PositionMs, Rate: rate(candidate)})
}

// publish sends a playback of this member's: what they did, or the
// coordinator's wait. s.mu is held.
func (s *Service) publish(sess *session, paused bool, positionMs int64, playRate float64, waiting bool) {
	if !sess.canControl() {
		return
	}
	at := sess.clock.nowMs()
	current := sess.playback
	next := backend.PartyPlayback{
		Seq: 1, MemberID: sess.memberID, Paused: paused, PositionMs: max(0, positionMs),
		Rate: math.Min(4, math.Max(0.25, playRate)), At: at, MediaKey: sess.media.Key(), Waiting: waiting,
	}
	if current != nil {
		next.Seq = current.Seq + 1
		if current.Paused && !paused {
			sess.resumedAt = s.now()
			if current.Waiting && !waiting {
				for _, id := range waitingMembers(sess.presence, sess.media.Key(), nil) {
					sess.ignored[id] = true
				}
			}
		}
	}
	if !waiting {
		sess.waitStarted = time.Time{}
	}
	sess.playback = &next
	sess.send("state", next)
	s.schedulePersist(sess)
}

// schedulePersist keeps the playback with the backend once it settles, for
// members who join later. s.mu is held.
func (s *Service) schedulePersist(sess *session) {
	if sess.persist != nil {
		sess.persist.Stop()
	}
	sess.persist = time.AfterFunc(persistAfter, func() {
		s.mu.Lock()
		if s.cur != sess || sess.playback == nil {
			s.mu.Unlock()
			return
		}
		playback := *sess.playback
		s.mu.Unlock()
		snap, err := s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
			return s.api.Update(ctx, sess.id, sess.deviceID, nil, &playback)
		})
		if err == nil {
			s.locked(sess, func() { s.applySnapshot(sess, snap) })
		}
	})
}

// publishMedia moves the party to media, from positionMs (the host only).
// s.mu is held.
func (s *Service) publishMedia(sess *session, media Media, positionMs int64) {
	wire := media.wire()
	if !sess.isHost() || wire.Key() == sess.media.Key() && media.Source == nil {
		return
	}
	same := wire.Key() == sess.media.Key()
	sess.media = wire
	var playback *backend.PartyPlayback
	if !same {
		next := backend.PartyPlayback{
			MemberID: sess.memberID, PositionMs: max(0, positionMs), Rate: 1,
			At: sess.clock.nowMs(), MediaKey: wire.Key(), Seq: 1,
		}
		if sess.playback != nil {
			next.Seq = sess.playback.Seq + 1
		}
		sess.playback = &next
		playback = &next
		sess.ignored = map[string]bool{}
	} else if sess.playback != nil {
		copied := *sess.playback
		playback = &copied
	}
	if sess.persist != nil {
		sess.persist.Stop()
	}
	go func() {
		snap, err := s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
			return s.api.Update(ctx, sess.id, sess.deviceID, &wire, playback)
		})
		if err == nil {
			s.locked(sess, func() { s.applySnapshot(sess, snap) })
		}
	}()
}

// setStatus tells the others how this member is doing, a moment later so a
// flicker sends nothing. s.mu is held.
func (s *Service) setStatus(sess *session, status, mediaKey string, behindMs int64) {
	next := presenceState{MemberID: sess.memberID, Status: status, MediaKey: mediaKey, BehindMs: behindMs}
	if sess.local != nil && *sess.local == next {
		return
	}
	sess.local = &next
	if status == StatusReady {
		delete(sess.ignored, sess.memberID)
	}
	sess.presence[sess.memberID] = next
	if sess.statusTimer != nil {
		sess.statusTimer.Stop()
	}
	sess.statusTimer = time.AfterFunc(statusAfter, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cur == sess && sess.local != nil {
			sess.send("status", *sess.local)
		}
	})
}

// sendStream shares stream (nil: none) as the host. s.mu is held.
func (s *Service) sendStream(sess *session, stream *Stream) {
	sess.shared = stream
	payload := map[string]any{"member_id": sess.memberID, "stream": nil}
	if stream != nil {
		payload["stream"] = stream.wire()
	}
	sess.send("stream", payload)
}

// heartbeats keeps the seat, and catches up on what the channel missed.
func (s *Service) heartbeats(sess *session) {
	t := time.NewTicker(s.heartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-sess.ctx.Done():
			return
		case <-t.C:
		}
		snap, err := s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
			return s.api.Heartbeat(ctx, sess.id, sess.deviceID)
		})
		s.locked(sess, func() {
			switch {
			case errors.Is(err, backend.ErrSignedOut):
				s.finish(sess, NoticeEnded)
			case err == nil:
				s.applySnapshot(sess, snap)
			}
		})
	}
}

// refineClock takes a few more samples of the server's clock, keeping the
// one with the shortest round trip.
func (s *Service) refineClock(sess *session) {
	for range clockSamples {
		if sleep(sess.ctx, clockGap) != nil {
			return
		}
		ctx, cancel := context.WithTimeout(sess.ctx, callWithin)
		sentAt := s.now()
		ms, err := s.api.Clock(ctx)
		cancel()
		if err == nil {
			sess.clock.add(ms, sentAt)
		}
	}
}

// loop follows the player every syncEvery and coordinates every
// coordinateEvery, while sess is the party.
func (s *Service) loop(sess *session) {
	t := time.NewTicker(s.syncEvery)
	defer t.Stop()
	var last time.Time
	for {
		select {
		case <-sess.ctx.Done():
			return
		case <-t.C:
		}
		s.locked(sess, func() {
			if me, err := s.who(); err == nil && (!me.Linked || me.Kids || me.ProfileID != sess.profileID) {
				// Another profile, or signed out: this one's party is left.
				s.stop(sess)
				go s.api.Leave(context.Background(), sess.id, sess.deviceID)
				s.notify(Notice{Kind: NoticeEnded})
				return
			}
			s.followPlayer(sess)
			if s.now().Sub(last) >= coordinateEvery {
				last = s.now()
				s.coordinate(sess)
			}
		})
	}
}

// coordinate pauses the party while members are loading or buffering, and
// resumes it once they're ready or after waitAtMost, when this member is
// the coordinator. s.mu is held.
func (s *Service) coordinate(sess *session) {
	if !sess.connected {
		return
	}
	online := map[string]bool{}
	for id := range sess.presence {
		online[id] = true
	}
	if coordinator(sess.members, online, sess.memberID, sess.hostID, sess.hostOnly) != sess.memberID {
		sess.waitStarted = time.Time{}
		return
	}
	pb := sess.playback
	if pb == nil || pb.MediaKey != "" && pb.MediaKey != sess.media.Key() {
		return
	}
	waiting := waitingMembers(sess.presence, sess.media.Key(), sess.ignored)
	now := s.now()
	switch {
	case !pb.Paused:
		graceOver := sess.resumedAt.IsZero() || now.Sub(sess.resumedAt) > resumeGrace
		if len(waiting) > 0 && graceOver {
			position := expectedPosition(*pb, sess.clock.nowMs(), 0)
			s.publish(sess, true, position, rate(*pb), true)
			sess.waitStarted = now
		}
	case pb.Waiting:
		if sess.waitStarted.IsZero() {
			sess.waitStarted = now
		}
		if len(waiting) == 0 || now.Sub(sess.waitStarted) > waitAtMost {
			for _, id := range waiting {
				sess.ignored[id] = true
			}
			s.publish(sess, false, pb.PositionMs, rate(*pb), false)
		}
	}
}

// rejoinOrFinish takes the seat back when the backend lost it (a long
// sleep, a restart), or ends the session if it can't. s.mu is held.
func (s *Service) rejoinOrFinish(sess *session) {
	if sess.rejoining {
		return
	}
	sess.rejoining = true
	go func() {
		me, err := s.who()
		var snap backend.PartySnapshot
		if err == nil {
			snap, err = s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
				return s.api.Join(ctx, sess.code, me.Identity)
			})
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		sess.rejoining = false
		if s.cur != sess {
			return
		}
		if err != nil || snap.Error != "" || snap.Party == nil || snap.MemberID == "" {
			kind := NoticeEnded
			if snap.Error == backend.PartyRemoved {
				kind = NoticeRemoved
			}
			s.finish(sess, kind)
			return
		}
		if snap.MemberID == sess.memberID {
			sess.members, sess.hostID = snap.Members, snap.Party.HostMemberID
			s.changed()
			return
		}
		playback := sess.playback
		s.stop(sess)
		s.begin(snap, me, s.now(), playback)
		s.changed()
	}()
}

var errNotJoined = backend.ErrNotJoined

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
