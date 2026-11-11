package nuvio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Watch parties (ADR-0051): Nuvio's apps watch together through the
// watch_party_* functions, which keep a party's members, what it watches and
// its last known playback, and a private Realtime channel per party
// (realtime.go), which carries playback, presence and chat between them.
// Self-host has neither, so these calls are checked by the live test only
// (contract_test.go's liveOnly).
//
// A function answers 200 with {"error": "<code>"} for a refusal (no such
// party, full, ended, removed), which PartySnapshot.Error carries; only a
// transport or auth failure is an error.

// Party error codes, as the functions answer them.
const (
	PartyNotFound    = "party_not_found"
	PartyFull        = "party_full"
	PartyEnded       = "party_ended"
	PartyRemoved     = "removed"
	PartyNotMember   = "not_member"
	PartyNotHost     = "not_host"
	PartyRateLimited = "rate_limited"
	PartyUnavailable = "unavailable"
)

// PartySource names the stream the host plays, so each member can find the
// same one among their own addons' streams.
type PartySource struct {
	InfoHash   string `json:"info_hash,omitempty"`
	FileIdx    *int   `json:"file_idx,omitempty"`
	Filename   string `json:"filename,omitempty"`
	VideoSize  int64  `json:"video_size,omitempty"`
	BingeGroup string `json:"binge_group,omitempty"`
	AddonID    string `json:"addon_id,omitempty"`
	Name       string `json:"name,omitempty"`
}

// PartyMedia is the film or episode a party watches.
type PartyMedia struct {
	Type         string       `json:"type"`
	MetaID       string       `json:"meta_id"`
	MetaType     string       `json:"meta_type"`
	VideoID      string       `json:"video_id,omitempty"`
	Season       *int         `json:"season,omitempty"`
	Episode      *int         `json:"episode,omitempty"`
	Title        string       `json:"title"`
	EpisodeTitle string       `json:"episode_title,omitempty"`
	Description  string       `json:"description,omitempty"`
	Poster       string       `json:"poster,omitempty"`
	Background   string       `json:"background,omitempty"`
	Logo         string       `json:"logo,omitempty"`
	Source       *PartySource `json:"source,omitempty"`
}

// Key is what Nuvio's apps compare to tell whether two members watch the
// same thing: "type|id|season|episode", the type in lower case.
func (m PartyMedia) Key() string {
	return PartyMediaKey(m.MetaType, m.MetaID, m.Season, m.Episode)
}

// PartyMediaKey is PartyMedia.Key from its parts.
func PartyMediaKey(metaType, metaID string, season, episode *int) string {
	part := func(n *int) string {
		if n == nil {
			return ""
		}
		return strconv.Itoa(*n)
	}
	return strings.Join([]string{strings.ToLower(metaType), metaID, part(season), part(episode)}, "|")
}

// PartyPlayback is where a party's playback is: Position at server time At
// (both in milliseconds), moving at Rate unless Paused. Seq orders them; a
// tie goes to the higher MemberID. Waiting is a pause for members still
// loading or buffering.
type PartyPlayback struct {
	Seq        int64   `json:"seq"`
	MemberID   string  `json:"member_id,omitempty"`
	Paused     bool    `json:"paused"`
	PositionMs int64   `json:"position_ms"`
	Rate       float64 `json:"rate"`
	At         int64   `json:"at"`
	MediaKey   string  `json:"media_key,omitempty"`
	Waiting    bool    `json:"waiting"`
}

// PartyMember is someone in a party.
type PartyMember struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	AvatarColor string `json:"avatar_color,omitempty"`
}

// PartyInfo is a party as the functions answer it.
type PartyInfo struct {
	ID           string         `json:"id"`
	Code         string         `json:"code"`
	HostMemberID string         `json:"host_member_id,omitempty"`
	HostOnly     bool           `json:"host_only"`
	Media        PartyMedia     `json:"media"`
	Playback     *PartyPlayback `json:"playback,omitempty"`
	MaxMembers   int            `json:"max_members"`
}

// PartySnapshot is what most party functions answer: the party, its members
// and which of them this device is, or Error. Update, leave and end answer
// only OK (and update the server's time), as live did on 2026-11-11.
type PartySnapshot struct {
	Party        *PartyInfo    `json:"party,omitempty"`
	Members      []PartyMember `json:"members,omitempty"`
	MemberID     string        `json:"member_id,omitempty"`
	ServerTimeMs int64         `json:"server_time_ms,omitempty"`
	OK           bool          `json:"ok,omitempty"`
	Error        string        `json:"error,omitempty"`
}

// PartyPreview is what joining by a code would join, or Error.
type PartyPreview struct {
	Media      *PartyMedia  `json:"media,omitempty"`
	Host       *PartyMember `json:"host,omitempty"`
	Members    int          `json:"members"`
	MaxMembers int          `json:"max_members"`
	Error      string       `json:"error,omitempty"`
}

// PartyMessage is one chat message. ClientID is the sender's own key for
// it, so the sender can match the stored message to the one it shows.
type PartyMessage struct {
	ID          int64  `json:"id"`
	MemberID    string `json:"member_id"`
	Name        string `json:"name"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	AvatarColor string `json:"avatar_color,omitempty"`
	Body        string `json:"body"`
	ClientID    string `json:"client_id,omitempty"`
	SentAt      int64  `json:"sent_at"`
	Mine        bool   `json:"mine"`
}

// PartyMessageSent is watch_party_send_message's answer.
type PartyMessageSent struct {
	Message *PartyMessage `json:"message,omitempty"`
	Error   string        `json:"error,omitempty"`
}

// PartyMessages is watch_party_list_messages' answer: the newest messages,
// oldest first.
type PartyMessages struct {
	Messages []PartyMessage `json:"messages"`
	Error    string         `json:"error,omitempty"`
}

// PartyIdentity is who joins: this device, and how the others see it.
type PartyIdentity struct {
	DeviceID    string
	DisplayName string
	// AvatarURL is an https image, AvatarColor "#rrggbb"; "" for none.
	AvatarURL   string
	AvatarColor string
	// ProfileIndex is the Nuvio profile, or nil.
	ProfileIndex *int
}

func (id PartyIdentity) params(more map[string]any) map[string]any {
	more["p_device_id"] = id.DeviceID
	more["p_display_name"] = id.DisplayName
	more["p_avatar_url"] = nullable(id.AvatarURL)
	more["p_avatar_color"] = nullable(id.AvatarColor)
	return more
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// PartyCreate starts a party watching media, with this device as its host.
func (c *Client) PartyCreate(ctx context.Context, s Session, id PartyIdentity, media PartyMedia) (PartySnapshot, error) {
	return c.partyWithProfile(ctx, s, "/rest/v1/rpc/watch_party_create", id,
		id.params(map[string]any{"p_media": media, "p_playback": nil}))
}

// PartyJoin joins the party with code, or takes this device's seat back.
func (c *Client) PartyJoin(ctx context.Context, s Session, code string, id PartyIdentity) (PartySnapshot, error) {
	return c.partyWithProfile(ctx, s, "/rest/v1/rpc/watch_party_join", id,
		id.params(map[string]any{"p_code": code}))
}

// partyWithProfile calls a function that takes the Nuvio profile, without
// it when the backend predates p_profile_index (PGRST202, no such function).
func (c *Client) partyWithProfile(ctx context.Context, s Session, path string, id PartyIdentity, params map[string]any) (PartySnapshot, error) {
	if id.ProfileIndex != nil {
		with := map[string]any{"p_profile_index": *id.ProfileIndex}
		for k, v := range params {
			with[k] = v
		}
		snapshot, err := c.partyCall(ctx, s, path, with)
		var api *APIError
		if !errors.As(err, &api) || api.Code != "PGRST202" {
			return snapshot, err
		}
	}
	return c.partyCall(ctx, s, path, params)
}

// PartyPreview says what joining code would join, without joining.
func (c *Client) PartyPreview(ctx context.Context, s Session, code string) (PartyPreview, error) {
	var out PartyPreview
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/watch_party_preview", s.AccessToken,
		map[string]any{"p_code": code}, &out)
	return out, err
}

// PartyHeartbeat keeps this device's seat, and answers the party as it is.
func (c *Client) PartyHeartbeat(ctx context.Context, s Session, partyID, deviceID string) (PartySnapshot, error) {
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_heartbeat", map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID,
	})
}

// PartyUpdate keeps what the party watches (the host only) and where its
// playback is, for members who join later; nil leaves either as it was.
func (c *Client) PartyUpdate(ctx context.Context, s Session, partyID, deviceID string, media *PartyMedia, playback *PartyPlayback) (PartySnapshot, error) {
	params := map[string]any{"p_party_id": partyID, "p_device_id": deviceID}
	if media != nil {
		params["p_media"] = media
	}
	if playback != nil {
		params["p_playback"] = playback
	}
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_update", params)
}

// PartyLeave gives up this device's seat. A host leaving hands the party on.
func (c *Client) PartyLeave(ctx context.Context, s Session, partyID, deviceID string) (PartySnapshot, error) {
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_leave", map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID,
	})
}

// PartyEnd ends the party for everyone (the host only).
func (c *Client) PartyEnd(ctx context.Context, s Session, partyID, deviceID string) (PartySnapshot, error) {
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_end", map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID,
	})
}

// PartySetHostOnly lets only the host control playback, or everyone.
func (c *Client) PartySetHostOnly(ctx context.Context, s Session, partyID, deviceID string, hostOnly bool) (PartySnapshot, error) {
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_set_host_only", map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID, "p_host_only": hostOnly,
	})
}

// PartyRemoveMember removes a member (the host only), who can't join again.
func (c *Client) PartyRemoveMember(ctx context.Context, s Session, partyID, deviceID, memberID string) (PartySnapshot, error) {
	return c.partyCall(ctx, s, "/rest/v1/rpc/watch_party_remove_member", map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID, "p_member_id": memberID,
	})
}

// PartySendMessage sends body to the party's chat; clientID is the
// sender's own key for it.
func (c *Client) PartySendMessage(ctx context.Context, s Session, partyID, deviceID, body, clientID string) (PartyMessageSent, error) {
	var out PartyMessageSent
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/watch_party_send_message", s.AccessToken, map[string]any{
		"p_party_id": partyID, "p_device_id": deviceID, "p_body": body, "p_client_id": clientID,
	}, &out)
	return out, err
}

// PartyMessages returns the chat's newest messages, or those after the
// message with ID after when it's above 0.
func (c *Client) PartyMessages(ctx context.Context, s Session, partyID, deviceID string, after int64) (PartyMessages, error) {
	params := map[string]any{"p_party_id": partyID, "p_device_id": deviceID}
	if after > 0 {
		params["p_after"] = after
	}
	var out PartyMessages
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/watch_party_list_messages", s.AccessToken, params, &out)
	return out, err
}

// PartyClock returns the server's time, in Unix milliseconds: the clock
// every member's playback times are on.
func (c *Client) PartyClock(ctx context.Context, s Session) (int64, error) {
	var ms json.Number
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/watch_party_clock", s.AccessToken, map[string]any{}, &ms)
	if err != nil {
		return 0, err
	}
	return ms.Int64()
}

// PartiesEnabled reports whether the backend allows watch parties now: its
// discovery document has the capability, and watch_party_enabled (which
// needs no session) says yes.
func (c *Client) PartiesEnabled(ctx context.Context) (bool, error) {
	base, _ := c.server()
	var doc discovery
	if err := c.do(ctx, base, http.MethodGet, "/.well-known/nuvio", nil, nil, &doc); err != nil {
		return false, err
	}
	if doc.Capabilities == nil || !doc.Capabilities.WatchParty {
		return false, nil
	}
	var enabled bool
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/watch_party_enabled", "", map[string]any{}, &enabled)
	return enabled, err
}

func (c *Client) partyCall(ctx context.Context, s Session, path string, params map[string]any) (PartySnapshot, error) {
	var out PartySnapshot
	err := c.call(ctx, http.MethodPost, path, s.AccessToken, params, &out)
	return out, err
}
