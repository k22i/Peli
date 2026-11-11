package party

import (
	"context"
	"crypto/rand"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/k22i/Peli/internal/backend"
)

// The party's chat: the backend keeps the messages and broadcasts each one
// it takes ("chat"); a member reads the history on joining and after the
// channel comes back, for what it missed. A message shows at once as
// sending, and is matched to the stored one by its client id.

// Message statuses.
const (
	MessageSent    = "sent"
	MessageSending = "sending"
	MessageFailed  = "failed"
)

// chatState is the chat of a session. Service.mu is held for all of it.
type chatState struct {
	entries []chatEntry
	loaded  bool
	syncing bool
	unread  int
}

// chatEntry is a message with what matching needs: its id once stored (0
// before), and the client id it was sent with.
type chatEntry struct {
	Message
	id       int64
	clientID string
}

// Chat returns the party's chat.
func (s *Service) Chat() Chat {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return Chat{Messages: []Message{}}
	}
	return chatOf(s.cur)
}

func chatOf(sess *session) Chat {
	out := Chat{Messages: make([]Message, 0, len(sess.chat.entries)), Unread: sess.chat.unread}
	for _, e := range sess.chat.entries {
		out.Messages = append(out.Messages, e.Message)
	}
	return out
}

func (s *Service) emitChat(sess *session) { s.emit(EventChat, chatOf(sess)) }

// SetChatOpen says whether the chat shows: while it does, nothing is unread.
func (s *Service) SetChatOpen(open bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.chatOpen = open
	if sess := s.cur; sess != nil && open && sess.chat.unread > 0 {
		sess.chat.unread = 0
		s.emitChat(sess)
	}
}

// SendMessage sends text (trimmed, at most 500 characters) to the chat.
func (s *Service) SendMessage(text string) error {
	body := strings.TrimSpace(text)
	if utf8.RuneCountInString(body) > messageMax {
		body = string([]rune(body)[:messageMax])
	}
	if body == "" {
		return &Error{Code: CodeInvalid}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.cur
	if sess == nil {
		return &Error{Code: CodeNotInParty}
	}
	clientID := newClientID()
	entry := chatEntry{
		Message: Message{
			Key: clientID, MemberID: sess.memberID, Name: sess.identity.DisplayName,
			AvatarURL: sess.identity.AvatarURL, AvatarColor: sess.identity.AvatarColor,
			Body: body, SentAt: sess.clock.nowMs(), Mine: true, Status: MessageSending,
		},
		clientID: clientID,
	}
	if m := sess.member(sess.memberID); m != nil {
		entry.Name, entry.AvatarURL, entry.AvatarColor = m.DisplayName, m.AvatarURL, m.AvatarColor
	}
	sess.chat.entries = append(sess.chat.entries, entry)
	s.emitChat(sess)
	s.deliver(sess, entry)
	return nil
}

// RetryMessage sends a message that failed again.
func (s *Service) RetryMessage(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.cur
	if sess == nil {
		return
	}
	for i := range sess.chat.entries {
		e := &sess.chat.entries[i]
		if e.Key == key && e.id == 0 && e.Status == MessageFailed {
			e.Status = MessageSending
			s.emitChat(sess)
			s.deliver(sess, *e)
			return
		}
	}
}

// deliver sends a message in the background. s.mu is held.
func (s *Service) deliver(sess *session, e chatEntry) {
	go func() {
		ctx, cancel := context.WithTimeout(sess.ctx, callWithin)
		defer cancel()
		sent, err := s.api.SendMessage(ctx, sess.id, sess.deviceID, e.Body, e.clientID)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cur != sess {
			return
		}
		if err != nil || sent.Message == nil {
			for i := range sess.chat.entries {
				if sess.chat.entries[i].Key == e.Key && sess.chat.entries[i].id == 0 {
					sess.chat.entries[i].Status = MessageFailed
				}
			}
			s.emitChat(sess)
			return
		}
		s.mergeChat(sess, []backend.PartyMessage{*sent.Message}, false, false)
	}()
}

// syncChat reads the history: all of it the first time, then what came
// after the newest message held; after a reconnect it also sends again
// what failed. s.mu is held.
func (s *Service) syncChat(sess *session, retry bool) {
	if retry {
		for i := range sess.chat.entries {
			if e := &sess.chat.entries[i]; e.Status == MessageFailed {
				e.Status = MessageSending
				s.deliver(sess, *e)
			}
		}
	}
	if sess.chat.syncing {
		return
	}
	sess.chat.syncing = true
	var after int64
	if sess.chat.loaded {
		for _, e := range sess.chat.entries {
			after = max(after, e.id)
		}
	}
	go func() {
		ctx, cancel := context.WithTimeout(sess.ctx, callWithin)
		defer cancel()
		history, err := s.api.Messages(ctx, sess.id, sess.deviceID, after)
		s.mu.Lock()
		defer s.mu.Unlock()
		sess.chat.syncing = false
		if s.cur != sess || err != nil || history.Error != "" {
			return
		}
		first := !sess.chat.loaded
		sess.chat.loaded = true
		s.mergeChat(sess, history.Messages, after > 0 && len(history.Messages) >= historyPage, !first)
	}()
}

// mergeChat adds stored messages to the chat: a message of this member's
// replaces the one it shows as sending, the rest are added in id order,
// and a full page after a gap drops what's older than it. Others' new
// messages count as unread unless the chat shows. s.mu is held.
func (s *Service) mergeChat(sess *session, incoming []backend.PartyMessage, replaceOlder, count bool) {
	slices.SortFunc(incoming, func(a, b backend.PartyMessage) int { return int(a.ID - b.ID) })
	var oldest int64
	for _, m := range incoming {
		if oldest == 0 || m.ID < oldest {
			oldest = m.ID
		}
	}
	var confirmed, pending []chatEntry
	known := map[int64]bool{}
	for _, e := range sess.chat.entries {
		switch {
		case e.id == 0:
			pending = append(pending, e)
		case !replaceOlder || oldest == 0 || e.id >= oldest:
			confirmed = append(confirmed, e)
			known[e.id] = true
		}
	}
	added := 0
	for _, m := range incoming {
		if m.ID == 0 || known[m.ID] {
			continue
		}
		known[m.ID] = true
		mine := m.Mine || m.MemberID == sess.memberID
		entry := chatEntry{
			Message: Message{
				Key: "id:" + itoa(m.ID), MemberID: m.MemberID, Name: m.Name, AvatarURL: m.AvatarURL,
				AvatarColor: m.AvatarColor, Body: m.Body, SentAt: m.SentAt, Mine: mine, Status: MessageSent,
			},
			id: m.ID, clientID: m.ClientID,
		}
		if i := slices.IndexFunc(pending, func(p chatEntry) bool { return mine && m.ClientID != "" && p.clientID == m.ClientID }); i >= 0 {
			entry.Key = pending[i].Key
			pending = slices.Delete(pending, i, i+1)
		} else if !mine {
			added++
		}
		confirmed = append(confirmed, entry)
	}
	slices.SortStableFunc(confirmed, func(a, b chatEntry) int { return int(a.id - b.id) })
	merged := append(confirmed, pending...)
	if len(merged) > messagesKept {
		merged = merged[len(merged)-messagesKept:]
	}
	sess.chat.entries = merged
	if count && !s.chatOpen {
		sess.chat.unread += added
	}
	s.emitChat(sess)
}

// newClientID is 20 letters and digits, as Nuvio's apps make them.
func newClientID() string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 20)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
