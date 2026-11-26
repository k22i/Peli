package party

import (
	"github.com/k22i/Peli/internal/backend"
)

// Events the service sends the frontend. Each carries the whole of what it
// names, so the frontend reads State (or Chat) when it mounts and then
// replaces it with each event.
const (
	EventState  = "party:state"
	EventNotice = "party:notice"
	EventChat   = "party:chat"
	// EventReaction carries a Reaction, one per emoji a member sends.
	EventReaction = "party:reaction"
	// EventActivity carries the party's whole Activity, on every change.
	EventActivity = "party:activity"
)

// Why parties can't be used now, in State.Unavailable.
const (
	// The backend has no watch parties, or turned them off.
	WhyUnavailable = "unavailable"
	// No Nuvio account, or the profile in use isn't one of its profiles.
	WhySignIn = "sign_in"
	// A kids profile: parties play whatever the host picks.
	WhyKids = "kids_profile"
)

// Member statuses, as each member tells the others ("status" broadcasts and
// presence). The frontend also sees StatusOffline, for a member who isn't on
// the channel.
const (
	StatusBrowsing  = "browsing"
	StatusLoading   = "loading"
	StatusBuffering = "buffering"
	StatusReady     = "ready"
	StatusBehind    = "behind"
	StatusOffline   = "offline"
)

// State is the party as the frontend shows it.
type State struct {
	// Unavailable is why parties can't be used, "" when they can.
	Unavailable string `json:"unavailable"`
	// Busy is true while starting or joining one.
	Busy  bool   `json:"busy"`
	Party *Party `json:"party"`
}

// Party is the party this device is in.
type Party struct {
	ID         string `json:"id"`
	Code       string `json:"code"`
	MemberID   string `json:"memberId"`
	HostID     string `json:"hostId"`
	IsHost     bool   `json:"isHost"`
	HostOnly   bool   `json:"hostOnly"`
	CanControl bool   `json:"canControl"`
	// Connected is false while the channel reconnects.
	Connected  bool     `json:"connected"`
	MaxMembers int      `json:"maxMembers"`
	Members    []Member `json:"members"`
	Media      Media    `json:"media"`
	// Watching is true while this device's player shows the party's media.
	Watching bool `json:"watching"`
	// Paused and Waiting are the party's playback: Waiting is a pause for
	// WaitingFor (names), who are still loading or buffering.
	Paused     bool     `json:"paused"`
	Waiting    bool     `json:"waiting"`
	WaitingFor []string `json:"waitingFor"`
	// Behind is true while this member watches on alone, BehindMs behind.
	Behind   bool  `json:"behind"`
	BehindMs int64 `json:"behindMs"`
	// Sharing is true while the host shares their stream; Shared is the
	// stream the host shares, for the others.
	Sharing bool    `json:"sharing"`
	Shared  *Stream `json:"shared"`
}

// Member is someone in the party, with how they're doing.
type Member struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AvatarURL   string `json:"avatarUrl"`
	AvatarColor string `json:"avatarColor"`
	Host        bool   `json:"host"`
	You         bool   `json:"you"`
	// Status is one of the Status constants; WatchingElse is true when they
	// watch something other than the party's media.
	Status       string `json:"status"`
	WatchingElse bool   `json:"watchingElse"`
	BehindMs     int64  `json:"behindMs"`
}

// Media is a film or episode as a party names it.
type Media struct {
	// Type is the addon type ("movie", "series"), ID the title's id and
	// VideoID the episode's.
	Type         string `json:"type"`
	ID           string `json:"id"`
	VideoID      string `json:"videoId"`
	Season       *int   `json:"season"`
	Episode      *int   `json:"episode"`
	Title        string `json:"title"`
	EpisodeTitle string `json:"episodeTitle"`
	Description  string `json:"description"`
	Poster       string `json:"poster"`
	Background   string `json:"background"`
	Logo         string `json:"logo"`
	// Source is the host's stream, for finding the same one.
	Source *Source `json:"source"`
}

// Source names a stream so others can find it in their own addons'.
type Source struct {
	InfoHash   string `json:"infoHash"`
	FileIdx    *int   `json:"fileIdx"`
	Filename   string `json:"filename"`
	VideoSize  int64  `json:"videoSize"`
	BingeGroup string `json:"bingeGroup"`
	AddonID    string `json:"addonId"`
	Name       string `json:"name"`
}

// Stream is a stream the host shares: a link the others can play as it is.
// It can carry the host's debrid key, which is why sharing is the host's
// choice each time.
type Stream struct {
	MediaKey        string            `json:"mediaKey"`
	URL             string            `json:"url"`
	Headers         map[string]string `json:"headers"`
	ResponseHeaders map[string]string `json:"responseHeaders"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	AddonName       string            `json:"addonName"`
	AddonID         string            `json:"addonId"`
	AddonLogo       string            `json:"addonLogo"`
	Filename        string            `json:"filename"`
	VideoSize       int64             `json:"videoSize"`
	BingeGroup      string            `json:"bingeGroup"`
	// SharedBy is the host's name.
	SharedBy string `json:"sharedBy"`
}

// Preview is what a code would join.
type Preview struct {
	// Error is "" or a code: party_not_found, party_full, party_ended,
	// removed, rate_limited, unavailable, network.
	Error      string `json:"error"`
	Media      *Media `json:"media"`
	Host       string `json:"host"`
	Members    int    `json:"members"`
	MaxMembers int    `json:"maxMembers"`
}

// Kinds of Notice.
const (
	// NoticeAction: Name paused, resumed, seeked to PositionMs or changed
	// the speed to Rate (Action).
	NoticeAction = "action"
	NoticeJoined = "joined"
	NoticeLeft   = "left"
	// NoticeEnded and NoticeRemoved: this device is out of the party.
	NoticeEnded   = "ended"
	NoticeRemoved = "removed"
	// NoticeMedia: the party watches Media now.
	NoticeMedia = "media"
	// NoticeControl: only the host controls playback now (HostOnly), or
	// everyone.
	NoticeControl = "control"
	// NoticeLocked: what the user tried is the host's to do.
	NoticeLocked = "locked"
	// NoticeCaughtUp: back in step after watching behind.
	NoticeCaughtUp = "caught_up"
)

// Notice is something to tell the user for a moment.
type Notice struct {
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Action     string  `json:"action"`
	PositionMs int64   `json:"positionMs"`
	Rate       float64 `json:"rate"`
	Media      *Media  `json:"media"`
	HostOnly   bool    `json:"hostOnly"`
}

// Chat is the party's chat as the frontend shows it.
type Chat struct {
	Messages []Message `json:"messages"`
	// Unread counts others' messages since the chat was last open.
	Unread int `json:"unread"`
}

// Message is one chat message. Status is "sent", "sending" or "failed".
type Message struct {
	Key         string `json:"key"`
	MemberID    string `json:"memberId"`
	Name        string `json:"name"`
	AvatarURL   string `json:"avatarUrl"`
	AvatarColor string `json:"avatarColor"`
	Body        string `json:"body"`
	SentAt      int64  `json:"sentAt"`
	Mine        bool   `json:"mine"`
	Status      string `json:"status"`
}

// Reaction is an emoji a member sent, for confetti. The sender gets their own
// too (Mine), so the frontend bursts only from the event.
type Reaction struct {
	Emoji    string `json:"emoji"`
	MemberID string `json:"memberId"`
	Name     string `json:"name"`
	Mine     bool   `json:"mine"`
	At       int64  `json:"at"`
}

// Kinds of ActivityEntry.
const (
	ActivityJoined  = "joined"
	ActivityLeft    = "left"
	ActivityPaused  = "paused"
	ActivityResumed = "resumed"
	ActivitySeeked  = "seeked"
	ActivitySpeed   = "speed"
	ActivityMedia   = "media"
)

// ActivityEntry is one line of the party's log: who did what, and when.
type ActivityEntry struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	MemberID   string  `json:"memberId"`
	Name       string  `json:"name"`
	PositionMs int64   `json:"positionMs"` // paused/resumed/seeked: where
	Rate       float64 `json:"rate"`       // speed: the new rate
	Title      string  `json:"title"`      // media: what the party started
	At         int64   `json:"at"`         // party clock, Unix ms
	Mine       bool    `json:"mine"`
}

// Activity is the party's log, oldest first.
type Activity struct {
	Entries []ActivityEntry `json:"entries"`
}

// presenceState is a "status" broadcast and what presence tracks.
type presenceState struct {
	MemberID string `json:"member_id"`
	Status   string `json:"status"`
	MediaKey string `json:"media_key,omitempty"`
	BehindMs int64  `json:"behind_ms,omitempty"`
}

// wireStream is a "stream" broadcast's stream, as Nuvio's apps send it.
type wireStream struct {
	MediaKey        string            `json:"media_key"`
	URL             string            `json:"url"`
	Headers         map[string]string `json:"headers"`
	ResponseHeaders map[string]string `json:"response_headers"`
	Name            string            `json:"name,omitempty"`
	Description     string            `json:"description,omitempty"`
	AddonName       string            `json:"addon_name"`
	AddonID         string            `json:"addon_id"`
	AddonLogo       string            `json:"addon_logo,omitempty"`
	Filename        string            `json:"filename,omitempty"`
	VideoSize       int64             `json:"video_size,omitempty"`
	BingeGroup      string            `json:"binge_group,omitempty"`
	StreamType      *string           `json:"stream_type"`
	Badges          []any             `json:"badges"`
}

func (m Media) wire() backend.PartyMedia {
	out := backend.PartyMedia{
		Type: m.Type, MetaID: m.ID, MetaType: m.Type, VideoID: m.VideoID,
		Season: m.Season, Episode: m.Episode, Title: m.Title, EpisodeTitle: m.EpisodeTitle,
		Description: m.Description, Poster: m.Poster, Background: m.Background, Logo: m.Logo,
	}
	if s := m.Source; s != nil {
		out.Source = &backend.PartySource{
			InfoHash: s.InfoHash, FileIdx: s.FileIdx, Filename: s.Filename, VideoSize: s.VideoSize,
			BingeGroup: s.BingeGroup, AddonID: s.AddonID, Name: s.Name,
		}
	}
	return out
}

// Key is the media's key, as the party compares them.
func (m Media) Key() string { return backend.PartyMediaKey(m.Type, m.ID, m.Season, m.Episode) }

func mediaOf(w backend.PartyMedia) Media {
	out := Media{
		Type: cmpOr(w.MetaType, w.Type), ID: w.MetaID, VideoID: w.VideoID, Season: w.Season, Episode: w.Episode,
		Title: w.Title, EpisodeTitle: w.EpisodeTitle, Description: w.Description,
		Poster: w.Poster, Background: w.Background, Logo: w.Logo,
	}
	if s := w.Source; s != nil {
		out.Source = &Source{
			InfoHash: s.InfoHash, FileIdx: s.FileIdx, Filename: s.Filename, VideoSize: s.VideoSize,
			BingeGroup: s.BingeGroup, AddonID: s.AddonID, Name: s.Name,
		}
	}
	return out
}

func (s Stream) wire() wireStream {
	return wireStream{
		MediaKey: s.MediaKey, URL: s.URL, Headers: orEmpty(s.Headers), ResponseHeaders: orEmpty(s.ResponseHeaders),
		Name: s.Name, Description: s.Description, AddonName: s.AddonName, AddonID: s.AddonID,
		AddonLogo: s.AddonLogo, Filename: s.Filename, VideoSize: s.VideoSize, BingeGroup: s.BingeGroup,
		Badges: []any{},
	}
}

func streamOf(w wireStream) Stream {
	return Stream{
		MediaKey: w.MediaKey, URL: w.URL, Headers: w.Headers, ResponseHeaders: w.ResponseHeaders,
		Name: w.Name, Description: w.Description, AddonName: w.AddonName, AddonID: w.AddonID,
		AddonLogo: w.AddonLogo, Filename: w.Filename, VideoSize: w.VideoSize, BingeGroup: w.BingeGroup,
	}
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
