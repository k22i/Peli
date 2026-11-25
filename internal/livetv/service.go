package livetv

import (
	"context"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/streams"
)

// Service is the Wails service for Live TV (W3: TODO, every method).
// Every method but Sources refuses a kids profile with CodeKids; Sources
// answers an empty list for one.
type Service struct {
	cfg Config
}

// NewService returns a Service. It does nothing until it starts.
func NewService(cfg Config) *Service {
	return &Service{cfg: cfg}
}

// ServiceStartup sends events from now on and starts the refresh timer.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	return nil
}

// ServiceShutdown stops the timer and any running fetch.
func (s *Service) ServiceShutdown() error {
	return nil
}

// Sources lists profileID's sources, oldest first. A stale one starts a
// background refresh and is returned as it was.
func (s *Service) Sources(profileID uint64) ([]Source, error) {
	_ = profileID
	return []Source{}, nil
}

// AddSource checks the input, keeps the URLs in the keychain, saves the
// record and starts its first refresh in the background.
func (s *Service) AddSource(in SourceInput) (Source, error) {
	_ = in
	return Source{}, fail(CodeFailed)
}

// RemoveSource deletes a source: its record, its keychain items and its
// cache, and its channels from the profile's favourites and recents.
func (s *Service) RemoveSource(profileID uint64, sourceID string) error {
	_, _ = profileID, sourceID
	return fail(CodeFailed)
}

// RenameSource sets a source's name.
func (s *Service) RenameSource(profileID uint64, sourceID, name string) error {
	_, _, _ = profileID, sourceID, name
	return fail(CodeFailed)
}

// Refresh fetches a source's playlist and guide again in the background, or
// every source of the profile's for sourceID "". It returns at once.
func (s *Service) Refresh(profileID uint64, sourceID string) error {
	_, _ = profileID, sourceID
	return fail(CodeFailed)
}

// Channels lists a source's channels in playlist order, or every source's
// (in source order) for sourceID "".
func (s *Service) Channels(profileID uint64, sourceID string) ([]Channel, error) {
	_, _ = profileID, sourceID
	return []Channel{}, nil
}

// Guide returns each channel's programmes that overlap [from, to) (unix ms),
// in the order of channelIDs. A channel with none has an empty list.
func (s *Service) Guide(profileID uint64, channelIDs []string, from, to int64) ([]ChannelGuide, error) {
	_, _, _, _ = profileID, channelIDs, from, to
	return []ChannelGuide{}, nil
}

// NowNext returns what each channel shows now and next, in the order of
// channelIDs.
func (s *Service) NowNext(profileID uint64, channelIDs []string) ([]NowNext, error) {
	_, _ = profileID, channelIDs
	return []NowNext{}, nil
}

// Stream returns the channel's stream for Player.Load (Origin
// "livetv:<channel id>") and puts the channel first in the profile's recent
// channels.
func (s *Service) Stream(profileID uint64, channelID string) (streams.Source, error) {
	_, _ = profileID, channelID
	return streams.Source{}, fail(CodeFailed)
}

// Favourites returns the profile's favourite channel ids, oldest first.
func (s *Service) Favourites(profileID uint64) ([]string, error) {
	_ = profileID
	return []string{}, nil
}

// SetFavourite adds a channel to the profile's favourites (at the end) or
// takes it out, and returns the new list.
func (s *Service) SetFavourite(profileID uint64, channelID string, on bool) ([]string, error) {
	_, _, _ = profileID, channelID, on
	return []string{}, fail(CodeFailed)
}

// Recent returns the channels the profile played last, newest first.
func (s *Service) Recent(profileID uint64) ([]string, error) {
	_ = profileID
	return []string{}, nil
}
