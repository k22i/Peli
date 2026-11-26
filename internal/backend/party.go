package backend

import (
	"context"

	"github.com/k22i/Peli/internal/nuvio"
)

// Watch parties (ADR-0051) as internal/party calls them: Nuvio's functions
// with the signed-in session, and the party's Realtime channel. The types
// are internal/nuvio's, named here so nothing else imports it.
type (
	PartyMedia       = nuvio.PartyMedia
	PartySource      = nuvio.PartySource
	PartyPlayback    = nuvio.PartyPlayback
	PartyMember      = nuvio.PartyMember
	PartyInfo        = nuvio.PartyInfo
	PartySnapshot    = nuvio.PartySnapshot
	PartyPreview     = nuvio.PartyPreview
	PartyMessage     = nuvio.PartyMessage
	PartyMessageSent = nuvio.PartyMessageSent
	PartyMessages    = nuvio.PartyMessages
	PartyIdentity    = nuvio.PartyIdentity
	ChannelHandler   = nuvio.ChannelHandler
	// SettingsBlob and SettingsBlobRow are the account's synced data
	// (ADR-0067), which a party's announcement rides in.
	SettingsBlob    = nuvio.SettingsBlob
	SettingsBlobRow = nuvio.SettingsBlobRow
)

// AnnouncePlatform is the platform key of Peli's own settings blob: never one
// of Nuvio's, whose blob is the user's real settings for that device type.
const AnnouncePlatform = nuvio.PlatformPeli

// The party functions' refusals.
const (
	PartyNotFound    = nuvio.PartyNotFound
	PartyFull        = nuvio.PartyFull
	PartyEnded       = nuvio.PartyEnded
	PartyRemoved     = nuvio.PartyRemoved
	PartyNotMember   = nuvio.PartyNotMember
	PartyNotHost     = nuvio.PartyNotHost
	PartyRateLimited = nuvio.PartyRateLimited
	PartyUnavailable = nuvio.PartyUnavailable
)

// ErrSignedOut means there's no session to call with.
var ErrSignedOut = nuvio.ErrSignedOut

// ErrNotJoined means a broadcast was dropped: the channel isn't joined.
var ErrNotJoined = nuvio.ErrNotJoined

// PartyMediaKey is PartyMedia.Key from its parts.
func PartyMediaKey(metaType, metaID string, season, episode *int) string {
	return nuvio.PartyMediaKey(metaType, metaID, season, episode)
}

// Channel is a party's Realtime channel, kept joined until Close.
type Channel interface {
	Send(event string, payload any) error
	Track(payload any) error
	Close()
}

// Parties calls the watch party functions with Sessions' session.
type Parties struct {
	Client   *nuvio.Client
	Sessions Sessions
}

func withSession[T any](ctx context.Context, sessions Sessions, fn func(nuvio.Session) (T, error)) (T, error) {
	var out T
	err := sessions.Do(ctx, func(s nuvio.Session) error {
		var err error
		out, err = fn(s)
		return err
	})
	return out, err
}

// Enabled reports whether the backend has watch parties turned on. It
// needs no session.
func (p Parties) Enabled(ctx context.Context) (bool, error) { return p.Client.PartiesEnabled(ctx) }

func (p Parties) Create(ctx context.Context, id PartyIdentity, media PartyMedia) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyCreate(ctx, s, id, media)
	})
}

func (p Parties) Join(ctx context.Context, code string, id PartyIdentity) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyJoin(ctx, s, code, id)
	})
}

func (p Parties) Preview(ctx context.Context, code string) (PartyPreview, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartyPreview, error) {
		return p.Client.PartyPreview(ctx, s, code)
	})
}

func (p Parties) Heartbeat(ctx context.Context, partyID, deviceID string) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyHeartbeat(ctx, s, partyID, deviceID)
	})
}

func (p Parties) Update(ctx context.Context, partyID, deviceID string, media *PartyMedia, playback *PartyPlayback) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyUpdate(ctx, s, partyID, deviceID, media, playback)
	})
}

func (p Parties) Leave(ctx context.Context, partyID, deviceID string) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyLeave(ctx, s, partyID, deviceID)
	})
}

func (p Parties) End(ctx context.Context, partyID, deviceID string) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyEnd(ctx, s, partyID, deviceID)
	})
}

func (p Parties) SetHostOnly(ctx context.Context, partyID, deviceID string, hostOnly bool) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartySetHostOnly(ctx, s, partyID, deviceID, hostOnly)
	})
}

func (p Parties) RemoveMember(ctx context.Context, partyID, deviceID, memberID string) (PartySnapshot, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartySnapshot, error) {
		return p.Client.PartyRemoveMember(ctx, s, partyID, deviceID, memberID)
	})
}

func (p Parties) SendMessage(ctx context.Context, partyID, deviceID, body, clientID string) (PartyMessageSent, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartyMessageSent, error) {
		return p.Client.PartySendMessage(ctx, s, partyID, deviceID, body, clientID)
	})
}

func (p Parties) Messages(ctx context.Context, partyID, deviceID string, after int64) (PartyMessages, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (PartyMessages, error) {
		return p.Client.PartyMessages(ctx, s, partyID, deviceID, after)
	})
}

func (p Parties) Clock(ctx context.Context) (int64, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (int64, error) {
		return p.Client.PartyClock(ctx, s)
	})
}

// Open joins the party's channel as member, with the session's token.
func (p Parties) Open(partyID, memberID string, handler ChannelHandler) Channel {
	token := func(ctx context.Context) (string, error) {
		return withSession(ctx, p.Sessions, func(s nuvio.Session) (string, error) { return s.AccessToken, nil })
	}
	return p.Client.OpenChannel("watch-party:"+partyID, memberID, token, handler)
}

// The account's synced data (ADR-0067), as a party's announcement uses it: a
// settings blob per profile, under the platform Peli owns. They ride here
// rather than in a backend of their own because nothing else uses them and
// their only caller is internal/party.

// AccountSettings reads profile index's blob for platform, and whether there
// is one.
func (p Parties) AccountSettings(ctx context.Context, index int, platform string) (SettingsBlobRow, bool, error) {
	var row SettingsBlobRow
	var ok bool
	err := p.Sessions.Do(ctx, func(s nuvio.Session) error {
		var err error
		row, ok, err = p.Client.ProfileSettings(ctx, s, index, platform)
		return err
	})
	return row, ok, err
}

// AccountSettingsList reads every profile's blob for platform: one request
// for the whole account.
func (p Parties) AccountSettingsList(ctx context.Context, platform string) ([]SettingsBlobRow, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) ([]SettingsBlobRow, error) {
		return p.Client.ProfileSettingsList(ctx, s, platform)
	})
}

// PutAccountSettings replaces profile index's blob for platform.
func (p Parties) PutAccountSettings(ctx context.Context, index int, platform string, blob SettingsBlob) error {
	return p.Sessions.Do(ctx, func(s nuvio.Session) error {
		return p.Client.PushProfileSettings(ctx, s, index, platform, blob)
	})
}

// PutAccountSettingsGuarded replaces the blob only while the row is still the
// one expectedUpdatedAt names, and answers its new updated_at.
func (p Parties) PutAccountSettingsGuarded(ctx context.Context, index int, platform string, blob SettingsBlob, expectedUpdatedAt string) (string, error) {
	return withSession(ctx, p.Sessions, func(s nuvio.Session) (string, error) {
		return p.Client.PushProfileSettingsGuarded(ctx, s, index, platform, blob, expectedUpdatedAt)
	})
}

// ClearAccountSettings removes profile index's blob for platform.
func (p Parties) ClearAccountSettings(ctx context.Context, index int, platform string) error {
	return p.Sessions.Do(ctx, func(s nuvio.Session) error {
		return p.Client.DeleteProfileSettings(ctx, s, index, platform)
	})
}
