package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// ProfileSettings follow a person rather than a machine: the languages they
// watch in and how they like subtitles. They are local: nothing here syncs
// through Nuvio (ADR-0048).
type ProfileSettings struct {
	// AudioLanguages are ISO 639 codes ("en", "jpn"), most preferred first
	// (#98); empty for the stream's own default. Before #98 a profile had
	// one, saved as "audioLanguage": ProfileSettings carries it over.
	AudioLanguages   []string `json:"audioLanguages"`
	SubtitleLanguage string   `json:"subtitleLanguage"`
	// SecondSubtitleLanguage is the language of the second line of subtitles
	// (dual subtitles) shown with the main ones when a file or addon has
	// it; "" for none.
	SecondSubtitleLanguage string `json:"secondSubtitleLanguage"`
	// SubtitleSize is the size from before subtitle styles, kept for older data: the
	// style's Size is what the player uses.
	SubtitleSize string `json:"subtitleSize"`
	// SubtitleStyle is how text subtitles look.
	SubtitleStyle SubtitleStyle `json:"subtitleStyle"`
	// "system" follows the OS's captions preference; "on" and "off" override it.
	Captions string `json:"captions"`
	// SkipIntros skips intros and recaps without asking, where their times
	// are known (#69). Credits are always the user's to skip.
	SkipIntros bool `json:"skipIntros"`
	// StillWatchingAfter is how many episodes play in a row, with no key
	// or pointer input, before the player asks "Still watching?" rather
	// than playing the next one; 0 never asks. Up to MaxStillWatchingAfter.
	StillWatchingAfter int `json:"stillWatchingAfter"`
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
	// AnimeInMoviesAndShows keeps anime the anime list knows in Movies,
	// Shows and their search results (#109). Off: it's the Anime tab's.
	AnimeInMoviesAndShows bool `json:"animeInMoviesAndShows"`
	// AnimePosterAddon is the URL of the addon whose posters the Anime tab
	// shows, where an entry is one film or show to it; "" keeps AniList's
	// covers. The catalog and its details stay AniList's.
	AnimePosterAddon string `json:"animePosterAddon"`
	// HideSpoilers blurs the stills and descriptions of episodes not yet
	// watched or started, each until it's revealed. Off unless the
	// profile turns it on; a kids profile has its own switch too.
	HideSpoilers bool `json:"hideSpoilers"`
	// Picture is the adjustment every title plays with, unless it has its
	// own (TitleAdjustments); PicturePresets are the profile's own presets.
	Picture        Picture        `json:"picture"`
	PicturePresets []NamedPicture `json:"picturePresets"`
	// Framing is how titles fill the window unless they have their own: the
	// fit and auto-crop are what a profile sets; the rest stays default.
	Framing Framing `json:"framing"`
	// Sound is how titles sound unless they have their own.
	Sound Sound `json:"sound"`
	// Gestures are the iOS touch player's swipes and taps (#131).
	Gestures Gestures `json:"gestures"`
}

// Gestures are which of the touch player's picture gestures are on (#131,
// Settings › Playback › Gestures on iOS).
type Gestures struct {
	// LevelSwipes: up and down on the left changes the brightness, on the
	// right the volume.
	LevelSwipes bool `json:"levelSwipes"`
	// SeekSwipe: sideways seeks.
	SeekSwipe bool `json:"seekSwipe"`
	// HoldForSpeed: holding the picture plays at 2× until let go.
	HoldForSpeed bool `json:"holdForSpeed"`
	// DoubleTapSkip is how far a double tap (and the skip buttons) skip, in
	// seconds: one of DoubleTapSkips.
	DoubleTapSkip int `json:"doubleTapSkip"`
}

// DoubleTapSkips are the skips a profile can pick, in seconds.
var DoubleTapSkips = []int{5, 10, 15, 30}

// DefaultGestures has every gesture on and 10 s skips.
func DefaultGestures() Gestures {
	return Gestures{LevelSwipes: true, SeekSwipe: true, HoldForSpeed: true, DoubleTapSkip: 10}
}

// SubtitleStyle is how text subtitles look: player.SubtitleStyle,
// saved with the profile.
type SubtitleStyle struct {
	// Font is one of SubtitleFonts.
	Font string `json:"font"`
	// Size is a percentage of the player's own size, 50–200.
	Size int `json:"size"`
	// Color is "#RRGGBB".
	Color string `json:"color"`
	// Edge is one of SubtitleEdges; Backdrop is the box's opacity, 0–100.
	Edge     string `json:"edge"`
	Backdrop int    `json:"backdrop"`
	// Lift raises the subtitles, in percent of the picture, 0–30.
	Lift int  `json:"lift"`
	Bold bool `json:"bold"`
	// Override restyles subtitles that bring their own styling too.
	Override bool `json:"override"`
}

// DefaultSubtitleStyle is a profile's style until it changes it: plain
// white sans with an outline, where the file puts it.
func DefaultSubtitleStyle() SubtitleStyle {
	return SubtitleStyle{Font: "sans", Size: 100, Color: "#FFFFFF", Edge: "outline", Backdrop: 60}
}

// subtitleSizePercent is an older SubtitleSize as a style's Size.
var subtitleSizePercent = map[string]int{"small": 75, "medium": 100, "large": 135}

// DeviceSettings belong to this machine, whoever is watching.
type DeviceSettings struct {
	HardwareDecoding bool `json:"hardwareDecoding"`
	// What the screen and speakers can show, for ranking streams (#98,
	// ADR-0048). MaxResolution is one of MaxResolutions: "auto" is no cap.
	// HDR and DolbyVision are one of DisplayModes: HDR "auto" follows the
	// display's report, Dolby Vision "auto" is off, as a webview can't see
	// it and the player doesn't report it.
	MaxResolution string `json:"maxResolution"`
	HDR           string `json:"hdr"`
	DolbyVision   string `json:"dolbyVision"`
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
	// Resolving the stream picker's top pick before it's picked, when it's
	// a cached debrid stream (#101, ADR-0060), so it starts sooner. Off
	// unless the user turns it on: resolving adds the file to the debrid
	// service's list, even if it never plays.
	PreResolve bool `json:"preResolve"`
	// How the stream picker sorts within each quality group: one of
	// StreamSorts. Filters last for the session; the sort stays.
	StreamSort string `json:"streamSort"`
	// Quality is how hard the renderer works on the picture, unless a
	// title has its own.
	Quality Quality `json:"quality"`
	// Audio is this device's output.
	Audio Audio `json:"audio"`
	// Looking for and downloading updates by itself (#83). On unless the
	// user turns it off; Peli still asks before it restarts.
	AutoUpdate bool `json:"autoUpdate"`
	// PartyDock keeps the watch party open beside the video instead of over
	// it (ADR-0051). Off until the user asks for it, so the party is the
	// sheet it always was; the compact iOS shell has no room for a dock.
	PartyDock bool `json:"partyDock"`
}

var (
	SubtitleSizes     = []string{"small", "medium", "large"}
	SubtitleFonts     = []string{"sans", "serif", "mono"}
	SubtitleEdges     = []string{"none", "outline", "shadow", "box"}
	hexRGB            = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	CaptionsModes     = []string{"system", "on", "off"}
	TorrentCacheSizes = []int{2, 5, 10, 20, 50}
	MaxResolutions    = []string{"auto", "2160p", "1080p", "720p"}
	DisplayModes      = []string{"auto", "on", "off"}
	StreamSorts       = []string{"best", "size-desc", "size-asc", "seeders"}
	// MaxAudioLanguages is how many audio languages a profile can list.
	MaxAudioLanguages = 8
	// MaxStillWatchingAfter is the most episodes a profile can let play in
	// a row before "Still watching?".
	MaxStillWatchingAfter = 10
	ErrInvalidSettings    = errors.New("store: invalid settings")

	languageCode = regexp.MustCompile(`^[a-z]{2,3}$`)
)

// DefaultProfileSettings are a profile's settings until it changes them.
func DefaultProfileSettings() ProfileSettings {
	return ProfileSettings{
		AudioLanguages: []string{}, SubtitleSize: "medium", SubtitleStyle: DefaultSubtitleStyle(), Captions: "system",
		StillWatchingAfter: 3,
		SimklScrobble:      true, SimklImport: true, SimklAnime: true,
		AniListProgress: true, AniListImport: true,
		Picture: DefaultPicture(), PicturePresets: []NamedPicture{}, Framing: DefaultFraming(),
		Sound: DefaultSound(), Gestures: DefaultGestures(),
	}
}

// DefaultDeviceSettings are the device's settings until they are changed.
func DefaultDeviceSettings() DeviceSettings {
	return DeviceSettings{
		HardwareDecoding: true, SkipTimesOnline: true, TorrentCacheGB: 5, AutoUpdate: true,
		MaxResolution: "auto", HDR: "auto", DolbyVision: "auto", Quality: DefaultQuality(),
		Audio: DefaultAudio(), StreamSort: "best",
	}
}

// ProfileSettings returns profile id's settings.
func (s *Store) ProfileSettings(id uint64) (ProfileSettings, error) {
	settings := DefaultProfileSettings()
	err := s.view(id, func(p *bolt.Bucket) error {
		data := p.Get(keySettings)
		if err := decodeOnto(data, &settings); err != nil {
			return err
		}
		return carryOverAudioLanguage(data, &settings)
	})
	if settings.AudioLanguages == nil {
		settings.AudioLanguages = []string{}
	}
	if settings.PicturePresets == nil {
		settings.PicturePresets = []NamedPicture{}
	}
	if settings.SubtitleStyle.Font == "" {
		// Saved before subtitle styles: the default style at the size picked then.
		settings.SubtitleStyle = DefaultSubtitleStyle()
		if size, ok := subtitleSizePercent[settings.SubtitleSize]; ok {
			settings.SubtitleStyle.Size = size
		}
	}
	return settings, err
}

// carryOverAudioLanguage turns the single "audioLanguage" a profile saved
// before #98 into a list of one, unless it already has a list.
func carryOverAudioLanguage(data []byte, settings *ProfileSettings) error {
	if data == nil || len(settings.AudioLanguages) > 0 {
		return nil
	}
	var old struct {
		AudioLanguage string `json:"audioLanguage"`
	}
	if err := json.Unmarshal(data, &old); err != nil {
		return err
	}
	if old.AudioLanguage != "" {
		settings.AudioLanguages = []string{old.AudioLanguage}
	}
	return nil
}

// SaveProfileSettings replaces profile id's settings. A picture or framing
// left empty (by a caller from before they existed) is the default.
func (s *Store) SaveProfileSettings(id uint64, settings ProfileSettings) error {
	if settings.Picture == (Picture{}) {
		settings.Picture = DefaultPicture()
	}
	if settings.Framing == (Framing{}) {
		settings.Framing = DefaultFraming()
	}
	if settings.Sound == (Sound{}) {
		settings.Sound = DefaultSound()
	}
	if settings.Gestures == (Gestures{}) {
		settings.Gestures = DefaultGestures()
	}
	if err := validateProfileSettings(settings); err != nil {
		return err
	}
	if settings.AudioLanguages == nil {
		settings.AudioLanguages = []string{}
	}
	if settings.PicturePresets == nil {
		settings.PicturePresets = []NamedPicture{}
	}
	return s.update(id, func(p *bolt.Bucket) error {
		return put(p, keySettings, settings)
	})
}

// SeedAudioLanguages gives a local-only profile (the Guest, or one made here)
// its audio languages from the device's preferred languages, the first time:
// when it has never saved settings. A profile that syncs with Nuvio, or one
// that has saved anything (an empty list included), is left as it is, so
// this never undoes a choice. Codes that aren't ISO 639 and repeats are
// dropped, and only MaxAudioLanguages are kept. It reports whether it saved.
func (s *Store) SeedAudioLanguages(id uint64, codes []string) (bool, error) {
	seeded := false
	err := s.update(id, func(p *bolt.Bucket) error {
		var profile Profile
		if err := json.Unmarshal(p.Get(keyProfile), &profile); err != nil {
			return err
		}
		if profile.NuvioIndex != nil || p.Get(keySettings) != nil {
			return nil
		}
		var list []string
		for _, code := range codes {
			if languageCode.MatchString(code) && !slices.Contains(list, code) && len(list) < MaxAudioLanguages {
				list = append(list, code)
			}
		}
		if len(list) == 0 {
			return nil
		}
		settings := DefaultProfileSettings()
		settings.AudioLanguages = list
		seeded = true
		return put(p, keySettings, settings)
	})
	return seeded, err
}

// DeviceSettings returns this device's settings.
func (s *Store) DeviceSettings() (DeviceSettings, error) {
	settings := DefaultDeviceSettings()
	err := s.db.View(func(tx *bolt.Tx) error {
		return decodeOnto(tx.Bucket(bucketSettings).Get(keyDevice), &settings)
	})
	return settings, err
}

// SaveDeviceSettings replaces this device's settings. A quality left empty
// (by a caller from before it existed) is the default.
func (s *Store) SaveDeviceSettings(settings DeviceSettings) error {
	if settings.Quality == (Quality{}) {
		settings.Quality = DefaultQuality()
	}
	if settings.Audio == (Audio{}) {
		settings.Audio = DefaultAudio()
	}
	if settings.StreamSort == "" {
		settings.StreamSort = "best"
	}
	if !slices.Contains(StreamSorts, settings.StreamSort) {
		return fmt.Errorf("%w: stream sort %q", ErrInvalidSettings, settings.StreamSort)
	}
	if !settings.Audio.Valid() {
		return fmt.Errorf("%w: audio %+v", ErrInvalidSettings, settings.Audio)
	}
	if !slices.Contains(TorrentCacheSizes, settings.TorrentCacheGB) {
		return fmt.Errorf("%w: torrent cache of %d GB", ErrInvalidSettings, settings.TorrentCacheGB)
	}
	if !slices.Contains(MaxResolutions, settings.MaxResolution) {
		return fmt.Errorf("%w: maximum resolution %q", ErrInvalidSettings, settings.MaxResolution)
	}
	for name, mode := range map[string]string{"HDR": settings.HDR, "Dolby Vision": settings.DolbyVision} {
		if !slices.Contains(DisplayModes, mode) {
			return fmt.Errorf("%w: %s %q", ErrInvalidSettings, name, mode)
		}
	}
	if !settings.Quality.Valid() {
		return fmt.Errorf("%w: quality %+v", ErrInvalidSettings, settings.Quality)
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
	for _, code := range append([]string{settings.SubtitleLanguage, settings.SecondSubtitleLanguage}, settings.AudioLanguages...) {
		if code != "" && !languageCode.MatchString(code) {
			return fmt.Errorf("%w: %q is not an ISO 639 language code", ErrInvalidSettings, code)
		}
	}
	// Each once, and none empty: an empty one would mean "no preference" in
	// the middle of a list.
	if len(settings.AudioLanguages) > MaxAudioLanguages {
		return fmt.Errorf("%w: %d audio languages", ErrInvalidSettings, len(settings.AudioLanguages))
	}
	for i, code := range settings.AudioLanguages {
		if code == "" || slices.Contains(settings.AudioLanguages[:i], code) {
			return fmt.Errorf("%w: audio language %q listed twice or empty", ErrInvalidSettings, code)
		}
	}
	if !slices.Contains(SubtitleSizes, settings.SubtitleSize) {
		return fmt.Errorf("%w: subtitle size %q", ErrInvalidSettings, settings.SubtitleSize)
	}
	style := settings.SubtitleStyle
	if !slices.Contains(SubtitleFonts, style.Font) || style.Size < 50 || style.Size > 200 ||
		!hexRGB.MatchString(style.Color) || !slices.Contains(SubtitleEdges, style.Edge) ||
		style.Backdrop < 0 || style.Backdrop > 100 || style.Lift < 0 || style.Lift > 30 {
		return fmt.Errorf("%w: subtitle style %+v", ErrInvalidSettings, style)
	}
	if !slices.Contains(CaptionsModes, settings.Captions) {
		return fmt.Errorf("%w: captions %q", ErrInvalidSettings, settings.Captions)
	}
	if settings.StillWatchingAfter < 0 || settings.StillWatchingAfter > MaxStillWatchingAfter {
		return fmt.Errorf("%w: still watching after %d episodes", ErrInvalidSettings, settings.StillWatchingAfter)
	}
	if !settings.Framing.Valid() {
		return fmt.Errorf("%w: framing %+v", ErrInvalidSettings, settings.Framing)
	}
	if !settings.Sound.Valid() {
		return fmt.Errorf("%w: sound %+v", ErrInvalidSettings, settings.Sound)
	}
	if !slices.Contains(DoubleTapSkips, settings.Gestures.DoubleTapSkip) {
		return fmt.Errorf("%w: double-tap skip of %d s", ErrInvalidSettings, settings.Gestures.DoubleTapSkip)
	}
	return validatePictures(settings.Picture, settings.PicturePresets)
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

// DeviceID returns this install's ID, made the first time it's asked for and
// kept from then on: a watch party (ADR-0051) knows a device by it, so Peli
// opened again takes its own seat back rather than a new one. It isn't on
// Service, so the webview never sees it.
func (s *Store) DeviceID() (string, error) {
	var id string
	err := s.db.View(func(tx *bolt.Tx) error {
		id = string(tx.Bucket(bucketSettings).Get(keyDeviceID))
		return nil
	})
	if err != nil || id != "" {
		return id, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		settings := tx.Bucket(bucketSettings)
		if kept := settings.Get(keyDeviceID); len(kept) > 0 {
			id = string(kept)
			return nil
		}
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		id = "peli-" + hex.EncodeToString(b)
		return settings.Put(keyDeviceID, []byte(id))
	})
	return id, err
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
