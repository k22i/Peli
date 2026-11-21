package party

import (
	"context"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// Suspension (iOS): the websocket dies when the app is suspended, and
// Realtime's own reconnect loop would spin while it can't. So going to the
// background closes the channel on purpose (Away) and coming back joins the
// party again and catches up (Back). The seat is kept all the while, with
// the backend's join as its proof: nothing here leaves the party, and a host
// away doesn't end it.
//
// They are plain functions, not methods, so Wails doesn't bind them.

// How many times Back asks the backend to join again when the network isn't
// up yet, and how long it waits between.
var (
	backTries = 3
	backRetry = time.Second
)

// Away is the app going to the background. The session stays, remembering
// the party and this member, but its channel is closed: a quiet socket
// instead of one the reconnect loop keeps retrying.
func Away(s *Service) {
	s.mu.Lock()
	sess := s.cur
	if sess == nil || sess.away {
		s.mu.Unlock()
		return
	}
	sess.away = true
	sess.connected = false
	for id := range sess.presence {
		if id != sess.memberID {
			delete(sess.presence, id)
		}
	}
	ch := sess.channel
	s.changed()
	s.mu.Unlock()
	// Close waits for the channel's goroutine, which may be waiting for s.mu.
	ch.Close()
}

// Back is the app active again. If a party was left by Away, it joins it
// again (the same seat, if the backend still has it), reads the party's
// state and catches the player up through the party's player, which skips
// the gate. A party that ended meanwhile, or that removed this member, ends
// the session with the notice the frontend already has for it.
func Back(s *Service) {
	s.mu.Lock()
	sess := s.cur
	if sess == nil || !sess.away {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	me, err := s.who()
	var snap backend.PartySnapshot
	sentAt := s.now()
	for try := 0; err == nil && try < backTries; try++ {
		if try > 0 && sleep(sess.ctx, backRetry) != nil {
			return
		}
		sentAt = s.now()
		snap, err = s.call(sess, func(ctx context.Context) (backend.PartySnapshot, error) {
			return s.api.Join(ctx, sess.code, me.Identity)
		})
		if err == nil {
			break
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != sess || !sess.away {
		return
	}
	defer s.changed()
	switch {
	case snap.Error == backend.PartyRemoved:
		s.finish(sess, NoticeRemoved)
	case snap.Error != "":
		// Ended, gone, full: the party isn't there to come back to.
		s.finish(sess, NoticeEnded)
	case err != nil || snap.Party == nil || snap.MemberID == "":
		// No network yet, or no account: keep the party and the seat; the
		// heartbeat finds out later if it ended.
		s.reopen(sess)
	case snap.MemberID != sess.memberID:
		// The seat was lost and this is a new one: a new session, carrying
		// the playback over.
		playback := sess.playback
		s.stop(sess)
		s.begin(snap, me, sentAt, playback)
		s.catchUp(s.cur)
	default:
		if snap.ServerTimeMs > 0 {
			sess.clock.add(snap.ServerTimeMs, sentAt)
		}
		s.reopen(sess)
		s.applySnapshot(sess, snap)
		s.catchUp(sess)
	}
}

// reopen opens the channel again for a session Away closed. s.mu is held.
func (s *Service) reopen(sess *session) {
	sess.away = false
	sess.channel = s.openChannel(sess)
}

// catchUp brings the player to the party's playback after the app came
// back. The guest follows the party (the next sync re-applies the playback
// as if it were new: pause, position, speed). The host's own state is the
// newest there is, so a host republishes where its player is, instead of
// snapping to the party's playback as it was before. s.mu is held.
func (s *Service) catchUp(sess *session) {
	if sess == nil || s.cur != sess {
		return
	}
	sess.away = false
	sess.sync.lastSeq = ""
	sess.sync.mismatchSince = time.Time{}
	if pb := sess.playback; pb != nil && sess.isHost() && pb.MemberID == sess.memberID &&
		s.watching != nil && s.watching.media.Key() == sess.media.Key() && s.player != nil {
		if st := s.player.Snapshot(); st.Active && !st.Loading {
			s.publish(sess, st.Paused, ms(st.Position), st.Speed, false)
		}
	}
	s.followPlayer(sess)
}
