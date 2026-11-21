package party

import (
	"encoding/json"
	"slices"
	"time"
)

// REACTIONS is the emoji a member can send, in the order the UI shows them.
var REACTIONS = []string{"😂", "❤️", "🔥", "😮", "😢", "👏", "🎉", "🍿"}

// reactionEvery is the least time between one member's reactions; the ones
// in between are dropped, so a flood from either end stays quiet.
const reactionEvery = 250 * time.Millisecond

// reactionState is what the rate limit remembers. Service.mu is held for it.
type reactionState struct {
	// lastSent is when this member last sent one; lastFrom, when each member
	// last had one accepted from the channel.
	lastSent time.Time
	lastFrom map[string]time.Time
}

// wireReaction is a "reaction" broadcast.
type wireReaction struct {
	Emoji    string `json:"emoji"`
	MemberID string `json:"member_id"`
	SentAt   int64  `json:"sent_at"`
}

// SendReaction shows emoji to every member, this one included. A reaction
// within 250 ms of the last one is dropped without an error.
func (s *Service) SendReaction(emoji string) error {
	if !slices.Contains(REACTIONS, emoji) {
		return &Error{Code: CodeInvalid}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.cur
	if sess == nil {
		return &Error{Code: CodeNotInParty}
	}
	now := s.now()
	if last := sess.reactions.lastSent; !last.IsZero() && now.Sub(last) < reactionEvery {
		return nil
	}
	sess.reactions.lastSent = now
	at := sess.clock.nowMs()
	sess.send("reaction", wireReaction{Emoji: emoji, MemberID: sess.memberID, SentAt: at})
	// The channel doesn't echo a member's own broadcasts.
	s.emit(EventReaction, Reaction{Emoji: emoji, MemberID: sess.memberID, Name: nameOf(sess, sess.memberID), Mine: true, At: at})
	return nil
}

// onReaction takes in another member's reaction. s.mu is held.
func (s *Service) onReaction(sess *session, payload json.RawMessage) {
	var w wireReaction
	if json.Unmarshal(payload, &w) != nil || w.MemberID == "" || !slices.Contains(REACTIONS, w.Emoji) {
		return
	}
	now := s.now()
	if last, ok := sess.reactions.lastFrom[w.MemberID]; ok && now.Sub(last) < reactionEvery {
		return
	}
	if sess.reactions.lastFrom == nil {
		sess.reactions.lastFrom = map[string]time.Time{}
	}
	sess.reactions.lastFrom[w.MemberID] = now
	s.emit(EventReaction, Reaction{
		Emoji: w.Emoji, MemberID: w.MemberID, Name: nameOf(sess, w.MemberID),
		Mine: w.MemberID == sess.memberID, At: w.SentAt,
	})
}

// nameOf is a member's name, "" if the session doesn't know them.
func nameOf(sess *session, id string) string {
	if m := sess.member(id); m != nil {
		return m.DisplayName
	}
	return ""
}
