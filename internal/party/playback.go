package party

import (
	"encoding/json"
	"math"
	"regexp"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/player"
)

// Following the player, as Nuvio's players follow theirs.
const (
	// Buffering this long is told to the others.
	bufferingAfter = time.Second
	// The player paused or playing against the party this long (a media
	// key, mpv itself) is taken as the user's.
	outsideAfter = 1200 * time.Millisecond
	// After a seek, drift isn't corrected for this long.
	seekSettle = 2500 * time.Millisecond
	// Drift is corrected at most this often.
	correctEvery = 500 * time.Millisecond
	// A seek lands late by about the time it takes; up to this is added to
	// seeks while playing, learned from how far off the last one landed.
	maxSeekLeadMs = 3000
	// How far behind is shown again only after it moves by this.
	behindShownStepMs = 1000
	// A drag of the seek bar holds off corrections this long after its
	// last move.
	scrubHold = time.Second
)

// syncState is what following the player remembers between ticks.
type syncState struct {
	prevKey        string
	bufferingSince time.Time
	mismatchSince  time.Time
	lastSeek       time.Time
	lastCorrection time.Time
	scrubbedAt     time.Time
	// The playback last applied ("" to apply the next one whatever it is).
	lastSeq          string
	lastStatus       string
	lastShared       string
	wasRendered      bool
	publishedInitial bool
	measureLead      bool
	wasBehind        bool
	leadMs           int64
}

// The stream links others can open: http(s) to a host that isn't this
// machine (a torrent plays from a loopback link).
var (
	linkURL     = regexp.MustCompile(`(?i)^https?://[^\s/]+`)
	loopbackURL = regexp.MustCompile(`(?i)^https?://(?:localhost|127\.|0\.0\.0\.0|\[::1\])`)
)

func shareable(url string) bool { return linkURL.MatchString(url) && !loopbackURL.MatchString(url) }

// player times in ms.
func ms(seconds float64) int64 { return int64(math.Round(seconds * 1000)) }

// followPlayer is one tick of following the player: telling the others how
// this member is doing, and keeping the player in step with the party.
// s.mu is held.
func (s *Service) followPlayer(sess *session) {
	w, p := s.watching, s.player
	if w == nil || p == nil {
		s.setStatus(sess, StatusBrowsing, "", 0)
		sess.sync.prevKey = ""
		return
	}
	st := p.Snapshot()
	key := w.media.Key()
	now := s.now()
	sy := &sess.sync

	// The host moved on (the next episode, another title): the party
	// follows.
	if sy.prevKey != key {
		prev := sy.prevKey
		sy.prevKey = key
		s.setBehind(sess, false)
		if prev != "" && sess.media.Key() == prev {
			s.publishMedia(sess, w.media, 0)
		}
	}

	if sess.isHost() && sess.sharing {
		var shared *Stream
		if w.stream != nil {
			copied := *w.stream
			copied.MediaKey = key
			shared = &copied
		}
		data, _ := json.Marshal(shared)
		if string(data) != sy.lastShared {
			sy.lastShared = string(data)
			s.sendStream(sess, shared)
		}
	}

	rendered := st.Active && !st.Loading
	if rendered && !sy.wasRendered {
		sy.lastSeq = ""
	}
	sy.wasRendered = rendered
	loading := st.Buffering || st.Seeking
	durationMs := ms(st.Duration)
	positionMs := ms(st.Position)
	ended := durationMs > 0 && positionMs >= durationMs-500
	partyKey := sess.media.Key()

	behindGap, haveGap := int64(0), false
	if pb := sess.playback; pb != nil && sess.behind && partyKey == key && st.Active {
		behindGap, haveGap = expectedPosition(*pb, sess.clock.nowMs(), durationMs)-positionMs, true
	}
	var status string
	switch {
	case !st.Active:
		status = StatusBrowsing
	case haveGap:
		status = StatusBehind
	case !rendered:
		status = StatusLoading
	case loading && !ended:
		if sy.bufferingSince.IsZero() {
			sy.bufferingSince = now
		}
		status = StatusReady
		if now.Sub(sy.bufferingSince) > bufferingAfter {
			status = StatusBuffering
		}
	default:
		sy.bufferingSince = time.Time{}
		status = StatusReady
	}
	var reported int64
	if status == StatusBehind {
		reported = reportedGap(behindGap)
	}
	s.setStatus(sess, status, key, reported)

	if partyKey != key || !st.Active {
		s.clearNudge(sess)
		return
	}
	pb := sess.playback
	if pb == nil {
		// A party just started from the player: the host's playback is the
		// first.
		if rendered && !sy.publishedInitial && sess.isHost() {
			sy.publishedInitial = true
			s.publish(sess, st.Paused, positionMs, st.Speed, false)
		}
		return
	}
	sy.publishedInitial = true
	if !rendered {
		return
	}
	if sess.behind && sess.canControl() {
		s.setBehind(sess, false)
	}
	if sess.behind {
		s.clearNudge(sess)
		sy.mismatchSince = time.Time{}
		gap := expectedPosition(*pb, sess.clock.nowMs(), durationMs) - positionMs
		if !st.Paused && !loading && gap <= rejoinGapMs {
			s.setBehind(sess, false)
		} else {
			if sess.behindMs == 0 || abs(gap-sess.behindMs) >= behindShownStepMs {
				sess.behindMs = max(1, gap)
			}
			sy.wasBehind = true
			return
		}
	}
	if sy.wasBehind {
		sy.wasBehind = false
		sy.lastSeq = ""
		if !sess.canControl() {
			s.notify(Notice{Kind: NoticeCaughtUp})
		}
	}

	expected := expectedPosition(*pb, sess.clock.nowMs(), durationMs)
	identity := pb.MemberID + "|" + itoa(pb.Seq)
	if identity != sy.lastSeq {
		forced := sy.lastSeq == ""
		sy.lastSeq = identity
		if forced || st.Paused != pb.Paused {
			_ = p.SetPaused(pb.Paused)
		}
		own := pb.MemberID == sess.memberID && !forced
		if (!own || pb.Paused) && abs(positionMs-expected) > pausedToleranceMs {
			target := expected
			if !pb.Paused {
				target += sy.leadMs
			}
			s.seek(sess, target, durationMs)
			sy.measureLead = !pb.Paused
		}
		sy.lastSeek = now
		if sess.nudged == 0 && math.Abs(st.Speed-rate(*pb)) > 0.01 {
			_ = p.SetSpeed(rate(*pb))
		}
		sy.mismatchSince = time.Time{}
		return
	}

	if loading || ended || now.Sub(sy.scrubbedAt) < scrubHold {
		sy.mismatchSince = time.Time{}
		return
	}

	playing := !st.Paused
	if playing == pb.Paused {
		if sy.mismatchSince.IsZero() {
			sy.mismatchSince = now
		}
		if now.Sub(sy.mismatchSince) > outsideAfter {
			sy.mismatchSince = time.Time{}
			switch {
			case sess.canControl():
				s.publish(sess, !playing, positionMs, rate(*pb), false)
			case playing:
				_ = p.SetPaused(pb.Paused)
			default:
				s.setBehind(sess, true)
			}
		}
		return
	}
	sy.mismatchSince = time.Time{}

	if !sy.lastSeek.IsZero() && now.Sub(sy.lastSeek) <= seekSettle {
		return
	}
	if !sy.lastCorrection.IsZero() && now.Sub(sy.lastCorrection) < correctEvery {
		return
	}
	sy.lastCorrection = now
	drift := positionMs - expected
	if sy.measureLead && !pb.Paused {
		sy.measureLead = false
		if abs(drift) < maxSeekLeadMs {
			sy.leadMs = min(maxSeekLeadMs, max(0, sy.leadMs-drift))
		}
	}
	c := correct(positionMs, expected, *pb, sess.nudged != 0)
	switch c.kind {
	case seekTo:
		s.clearNudge(sess)
		target := c.positionMs
		if !pb.Paused {
			target += sy.leadMs
		}
		s.seek(sess, target, durationMs)
		sy.lastSeek = now
		sy.measureLead = !pb.Paused
	case nudge:
		if sess.nudged != c.rate {
			sess.nudged = c.rate
			_ = p.SetSpeed(c.rate)
		}
	default:
		s.clearNudge(sess)
	}
}

func (s *Service) seek(sess *session, targetMs, durationMs int64) {
	if durationMs > 0 {
		targetMs = min(targetMs, durationMs)
	}
	_ = s.player.Seek(float64(max(0, targetMs)) / 1000)
}

// clearNudge puts the player back at the party's rate. s.mu is held.
func (s *Service) clearNudge(sess *session) {
	if sess.nudged == 0 {
		return
	}
	sess.nudged = 0
	if s.player != nil {
		_ = s.player.SetSpeed(rate(orZero(sess.playback)))
	}
}

// setBehind starts or stops watching on alone. s.mu is held.
func (s *Service) setBehind(sess *session, behind bool) {
	if sess.behind == behind {
		return
	}
	sess.behind = behind
	if !behind {
		sess.behindMs = 0
	}
}

// leavePlayback is the player leaving the party's media: the last one
// watching pauses the party where they stopped, so it waits for them. s.mu
// is held.
func (s *Service) leavePlayback(sess *session) {
	w := s.watching
	pb := sess.playback
	if w == nil || pb == nil || w.media.Key() != sess.media.Key() || pb.Paused {
		s.setStatus(sess, StatusBrowsing, "", 0)
		return
	}
	others := false
	for id, p := range sess.presence {
		if id != sess.memberID && p.MediaKey == sess.media.Key() && p.Status != StatusBrowsing {
			others = true
		}
	}
	if !others && s.player != nil {
		st := s.player.Snapshot()
		position := pb.PositionMs
		if st.Active {
			position = ms(st.Position)
		}
		s.publish(sess, true, position, rate(*pb), false)
	}
	s.setStatus(sess, StatusBrowsing, "", 0)
	s.clearNudge(sess)
	sess.sync = syncState{}
}

// The gate (player.Gate): the user's own pauses, seeks and speed changes,
// before mpv acts on them. While the player shows the party's media, they
// are published, or refused when only the host controls playback; a guest
// can still pause or go back for themselves, watching behind.

// GateOf is s as the player's gate. It isn't a method, so Wails doesn't
// bind the gate's methods for the webview.
func GateOf(s *Service) player.Gate { return gate{s} }

type gate struct{ s *Service }

// gated returns the party and the player's state when the player shows the
// party's media. s.mu is held.
func (s *Service) gated() (*session, player.State, bool) {
	sess := s.cur
	if sess == nil || s.watching == nil || s.player == nil || s.watching.media.Key() != sess.media.Key() {
		return nil, player.State{}, false
	}
	st := s.player.Snapshot()
	return sess, st, st.Active
}

// UserPause is asked before the user pauses or resumes.
func (g gate) UserPause(paused bool) bool {
	s := g.s
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, st, ok := s.gated()
	if !ok {
		return true
	}
	defer s.changed()
	if sess.canControl() {
		s.publish(sess, paused, ms(st.Position), partyRate(sess, st), false)
		sess.sync.lastSeq = identityOf(sess.playback)
		return true
	}
	switch {
	case paused:
		s.setBehind(sess, true)
		return true
	case sess.behind:
		return true
	}
	s.notify(Notice{Kind: NoticeLocked})
	return false
}

// UserSeek is asked before the user seeks to position (seconds); it
// returns where to go, or false to stay.
func (g gate) UserSeek(position float64) (float64, bool) {
	s := g.s
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, st, ok := s.gated()
	if !ok {
		return position, true
	}
	defer s.changed()
	target := ms(position)
	if sess.canControl() {
		s.publish(sess, st.Paused, target, partyRate(sess, st), false)
		sess.sync.lastSeq = identityOf(sess.playback)
		sess.sync.lastSeek = s.now()
		return position, true
	}
	if pb := sess.playback; pb != nil {
		partyMs := expectedPosition(*pb, sess.clock.nowMs(), ms(st.Duration))
		switch ownSeek(target, partyMs, sess.behind) {
		case seekBehind:
			s.setBehind(sess, true)
			return position, true
		case seekCatchUp:
			s.setBehind(sess, false)
			return position, false
		}
	}
	s.notify(Notice{Kind: NoticeLocked})
	return position, false
}

// UserSpeed is asked before the user changes the speed.
func (g gate) UserSpeed(speed float64) bool {
	s := g.s
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, st, ok := s.gated()
	if !ok {
		return true
	}
	if !sess.canControl() {
		s.notify(Notice{Kind: NoticeLocked})
		return false
	}
	s.clearNudge(sess)
	s.publish(sess, st.Paused, ms(st.Position), speed, false)
	sess.sync.lastSeq = identityOf(sess.playback)
	s.changed()
	return true
}

// UserScrub is told while the user drags the seek bar: corrections wait.
func (g gate) UserScrub() {
	s := g.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.cur; sess != nil {
		sess.sync.scrubbedAt = s.now()
	}
}

// partyRate is the rate playback runs at for the party: not a nudge.
func partyRate(sess *session, st player.State) float64 {
	if sess.nudged != 0 && sess.playback != nil {
		return rate(*sess.playback)
	}
	if st.Speed > 0 {
		return st.Speed
	}
	return 1
}

func identityOf(pb *backend.PartyPlayback) string {
	if pb == nil {
		return ""
	}
	return pb.MemberID + "|" + itoa(pb.Seq)
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
