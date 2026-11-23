package party

import (
	"cmp"
	"encoding/json"
	"math/rand/v2"
	"slices"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// The party's log: one line per thing a member did, kept by every member.
// Someone who joins later asks the others for theirs, Peli to Peli, so they
// see what happened before they came. An entry's id is the same on every
// device, which is how a handed-over line isn't added twice.

const (
	// The newest entries kept.
	activityKept = 200
	// The entries a hand-over reply carries.
	activityHanded = 150
	// A hand-over reply waits a moment, so a party with several members
	// has one answer rather than all of them.
	activityReplyMin = 200 * time.Millisecond
	activityReplyMax = 1500 * time.Millisecond
	// Two seeks by one member this close together are one line: a scrub
	// isn't a line a second.
	activitySeekGapMs = 5000
)

// activityState is the log of a session, and the hand-over reply owed to a
// member who asked for it. Service.mu is held for all of it.
type activityState struct {
	entries []ActivityEntry
	// The hand-over reply this member will send, and to whom.
	replyTimer *time.Timer
	replyTo    string
}

// activityKinds are the kinds a log holds, so a strange one is dropped.
var activityKinds = map[string]bool{
	ActivityJoined: true, ActivityLeft: true, ActivityPaused: true, ActivityResumed: true,
	ActivitySeeked: true, ActivitySpeed: true, ActivityMedia: true,
}

// wireActivity is one entry of an "activity" broadcast.
type wireActivity struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	MemberID   string  `json:"member_id"`
	Name       string  `json:"name"`
	PositionMs int64   `json:"position_ms,omitempty"`
	Rate       float64 `json:"rate,omitempty"`
	Title      string  `json:"title,omitempty"`
	At         int64   `json:"at"`
}

// wireActivityLog is an "activity" broadcast: the log one member hands to
// another.
type wireActivityLog struct {
	To      string         `json:"to"`
	From    string         `json:"from"`
	Entries []wireActivity `json:"entries"`
}

// Activity returns the party's log; empty (not nil) outside a party.
func (s *Service) Activity() Activity {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return Activity{Entries: []ActivityEntry{}}
	}
	return activityOf(s.cur)
}

// activityOf is sess's log as the frontend shows it. s.mu is held.
func activityOf(sess *session) Activity {
	entries := make([]ActivityEntry, 0, len(sess.activity.entries))
	return Activity{Entries: append(entries, sess.activity.entries...)}
}

// record adds e to the party's log, unless it's there already; a member's
// scrubbing becomes one line. s.mu is held.
func (s *Service) record(sess *session, e ActivityEntry) {
	e.Mine = e.MemberID == sess.memberID
	if e.Name == "" {
		e.Name = nameOf(sess, e.MemberID)
	}
	if slices.ContainsFunc(sess.activity.entries, func(a ActivityEntry) bool { return a.ID == e.ID }) {
		return
	}
	// Dragging the seek bar: the line moves with it rather than piling up.
	if e.Kind == ActivitySeeked && len(sess.activity.entries) > 0 {
		last := &sess.activity.entries[len(sess.activity.entries)-1]
		if last.Kind == ActivitySeeked && last.MemberID == e.MemberID && e.At-last.At <= activitySeekGapMs {
			last.PositionMs, last.At = e.PositionMs, e.At
			s.emit(EventActivity, activityOf(sess))
			return
		}
	}
	sess.activity.entries = append(sess.activity.entries, e)
	if n := len(sess.activity.entries); n > activityKept {
		sess.activity.entries = sess.activity.entries[n-activityKept:]
	}
	s.emit(EventActivity, activityOf(sess))
}

// mediaTitle is what the log calls media: its title, with the episode's
// number for one of a series. "" when it has no title.
func mediaTitle(m backend.PartyMedia) string {
	if m.Title == "" {
		return ""
	}
	if m.Season != nil && m.Episode != nil {
		return m.Title + " S" + itoa(int64(*m.Season)) + " E" + itoa(int64(*m.Episode))
	}
	return m.Title
}

// wireOf is e as a hand-over carries it.
func wireOf(e ActivityEntry) wireActivity {
	return wireActivity{
		ID: e.ID, Kind: e.Kind, MemberID: e.MemberID, Name: e.Name,
		PositionMs: e.PositionMs, Rate: e.Rate, Title: e.Title, At: e.At,
	}
}

// onActivityRequest answers a member who joined later with the log, after a
// moment so only one member answers. s.mu is held.
func (s *Service) onActivityRequest(sess *session, payload json.RawMessage) {
	var w struct {
		MemberID string `json:"member_id"`
	}
	if json.Unmarshal(payload, &w) != nil || w.MemberID == "" || w.MemberID == sess.memberID {
		return
	}
	if len(sess.activity.entries) == 0 {
		return
	}
	if sess.activity.replyTimer != nil {
		sess.activity.replyTimer.Stop()
	}
	sess.activity.replyTo = w.MemberID
	delay := activityReplyMin + rand.N(activityReplyMax-activityReplyMin)
	sess.activity.replyTimer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cur != sess {
			return
		}
		to := sess.activity.replyTo
		sess.activity.replyTimer, sess.activity.replyTo = nil, ""
		if to == "" {
			return // someone else answered first
		}
		entries := sess.activity.entries
		if len(entries) > activityHanded {
			entries = entries[len(entries)-activityHanded:]
		}
		out := make([]wireActivity, 0, len(entries))
		for _, e := range entries {
			out = append(out, wireOf(e))
		}
		sess.send("activity", wireActivityLog{To: to, From: sess.memberID, Entries: out})
	})
}

// onActivityLog takes in another member's log and fills the gaps in this
// one, oldest first. s.mu is held.
func (s *Service) onActivityLog(sess *session, payload json.RawMessage) {
	var w wireActivityLog
	if json.Unmarshal(payload, &w) != nil {
		return
	}
	// Someone answered the member this one was about to answer too.
	if w.To == sess.activity.replyTo && w.From != sess.memberID && sess.activity.replyTimer != nil {
		sess.activity.replyTimer.Stop()
		sess.activity.replyTimer, sess.activity.replyTo = nil, ""
	}
	known := map[string]bool{}
	for _, e := range sess.activity.entries {
		known[e.ID] = true
	}
	added := false
	for _, e := range w.Entries {
		if e.ID == "" || !activityKinds[e.Kind] || known[e.ID] {
			continue
		}
		known[e.ID] = true
		entry := ActivityEntry{
			ID: e.ID, Kind: e.Kind, MemberID: e.MemberID, Name: e.Name,
			PositionMs: e.PositionMs, Rate: e.Rate, Title: e.Title, At: e.At,
			Mine: e.MemberID == sess.memberID,
		}
		if entry.Name == "" {
			entry.Name = nameOf(sess, entry.MemberID)
		}
		sess.activity.entries = append(sess.activity.entries, entry)
		added = true
	}
	if !added {
		return
	}
	slices.SortStableFunc(sess.activity.entries, func(a, b ActivityEntry) int { return cmp.Compare(a.At, b.At) })
	if n := len(sess.activity.entries); n > activityKept {
		sess.activity.entries = sess.activity.entries[n-activityKept:]
	}
	s.emit(EventActivity, activityOf(sess))
}
