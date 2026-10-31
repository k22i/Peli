package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// ProfileSettings follow a person rather than a machine: the languages they
// watch in and how they like subtitles. They are local for now: whether they
// sync through Nuvio's per-platform settings blob is for the sync module (#28).
type ProfileSettings struct {
	// ISO 639 codes ("en", "jpn"), or "" for the stream's own default.
	AudioLanguage    string `json:"audioLanguage"`
	SubtitleLanguage string `json:"subtitleLanguage"`
	SubtitleSize     string `json:"subtitleSize"`
	// "system" follows the OS's captions preference; "on" and "off" override it.
	Captions string `json:"captions"`
	// SkipIntros skips intros and recaps without asking, where their times
	// are known (#69). Credits are always the user's to skip.
	SkipIntros bool `json:"skipIntros"`
	// SIMKL (#72): scrobble what plays, import the watched history, and
	// include anime in both. Profiles that keep anime on AniList turn
	// SimklAnime off.
	SimklScrobble bool `json:"simklScrobble"`
	SimklImport   bool `json:"simklImport"`
	SimklAnime    bool `json:"simklAnime"`
	// AniList (#104): update the list's progress when an episode is
	// watched, and import the list into watched marks.
	AniListProgress bool `json:"anilistProgress"`
	AniListImport   bool `json:"anilistImport"`
}

// DeviceSettings belong to this machine, whoever is watching.
type DeviceSettings struct {
	HardwareDecoding bool `json:"hardwareDecoding"`
	// Asking IntroDB where intros and credits are (#69), for files without
	// chapters that say so. On unless the user turns it off: it tells IntroDB
	// what's playing, by IMDb id.
	SkipTimesOnline bool `json:"skipTimesOnline"`
	// Opt-in crash reports and play outcomes (#90). Off unless the user turns
	// it on.
	Diagnostics bool `json:"diagnostics"`
	// Streaming torrents peer to peer (#55): off unless the user turns it
	// on, since peers see their IP address. The piece cache's cap, in GB.
	TorrentStreaming bool `json:"torrentStreaming"`
	TorrentCacheGB   int  `json:"torrentCacheGB"`
}

var (
	SubtitleSizes      = []string{"small", "medium", "large"}
	CaptionsModes      = []string{"system", "on", "off"}
	TorrentCacheSizes  = []int{2, 5, 10, 20, 50}
	ErrInvalidSettings = errors.New("store: invalid settings")

	languageCode = regexp.MustCompile(`^[a-z]{2,3}$`)
)

// DefaultProfileSettings are a profile's settings until it changes them.
func DefaultProfileSettings() ProfileSettings {
	return ProfileSettings{
		SubtitleSize: "medium", Captions: "system",
		SimklScrobble: true, SimklImport: true, SimklAnime: true,
		AniListProgress: true, AniListImport: true,
	}
}

// DefaultDeviceSettings are the device's settings until they are changed.
func DefaultDeviceSettings() DeviceSettings {
	return DeviceSettings{HardwareDecoding: true, SkipTimesOnline: true, TorrentCacheGB: 5}
}

// ProfileSettings returns profile id's settings.
func (s *Store) ProfileSettings(id uint64) (ProfileSettings, error) {
	settings := DefaultProfileSettings()
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(keySettings), &settings)
	})
	return settings, err
}

// SaveProfileSettings replaces profile id's settings.
func (s *Store) SaveProfileSettings(id uint64, settings ProfileSettings) error {
	if err := validateProfileSettings(settings); err != nil {
		return err
	}
	return s.update(id, func(p *bolt.Bucket) error {
		return put(p, keySettings, settings)
	})
}

// DeviceSettings returns this device's settings.
func (s *Store) DeviceSettings() (DeviceSettings, error) {
	settings := DefaultDeviceSettings()
	err := s.db.View(func(tx *bolt.Tx) error {
		return decodeOnto(tx.Bucket(bucketSettings).Get(keyDevice), &settings)
	})
	return settings, err
}

// SaveDeviceSettings replaces this device's settings.
func (s *Store) SaveDeviceSettings(settings DeviceSettings) error {
	if !slices.Contains(TorrentCacheSizes, settings.TorrentCacheGB) {
		return fmt.Errorf("%w: torrent cache of %d GB", ErrInvalidSettings, settings.TorrentCacheGB)
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bucketSettings), keyDevice, settings)
	})
}

// decodeOnto decodes data over v's defaults, so fields added later keep their
// default in records saved before them. Nil data leaves v as it is.
func decodeOnto(data []byte, v any) error {
	if data == nil {
		return nil
	}
	return json.Unmarshal(data, v)
}

func validateProfileSettings(settings ProfileSettings) error {
	for _, code := range []string{settings.AudioLanguage, settings.SubtitleLanguage} {
		if code != "" && !languageCode.MatchString(code) {
			return fmt.Errorf("%w: %q is not an ISO 639 language code", ErrInvalidSettings, code)
		}
	}
	if !slices.Contains(SubtitleSizes, settings.SubtitleSize) {
		return fmt.Errorf("%w: subtitle size %q", ErrInvalidSettings, settings.SubtitleSize)
	}
	if !slices.Contains(CaptionsModes, settings.Captions) {
		return fmt.Errorf("%w: captions %q", ErrInvalidSettings, settings.Captions)
	}
	return nil
}

// Server returns the URL of the user's own Nuvio backend (#34), or "" for
// Nuvio's. Its key, if it needs one, is in the keychain (ADR-0007).
func (s *Store) Server() (string, error) {
	var server string
	err := s.db.View(func(tx *bolt.Tx) error {
		server = string(tx.Bucket(bucketSettings).Get(keyServer))
		return nil
	})
	return server, err
}

// SetServer keeps the URL of the user's own Nuvio backend, or "" for Nuvio's.
// It isn't on Service: switching signs out first (account.Service.SetServer).
func (s *Store) SetServer(url string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		if url == "" {
			return tx.Bucket(bucketSettings).Delete(keyServer)
		}
		return tx.Bucket(bucketSettings).Put(keyServer, []byte(url))
	})
}
