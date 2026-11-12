//go:build !ios

package player

import (
	"log/slog"
	"strconv"

	"github.com/k22i/Peli/internal/store"
)

// shadowLift is how far ShadowLift raises gamma: enough to open up a dark
// scene's shadows without washing out a bright one.
const shadowLift = 15

// pictureProps are the mpv properties that adjust the picture as p says.
// They are the VO's equalizer: the renderer applies them in its colour
// matrix (macOS's gpu renderer and Windows' gpu-next alike), so they cost
// nothing and hardware decoding stays zero-copy. Hue only moves YUV video.
func pictureProps(p store.Picture) [][2]string {
	gamma := p.Gamma
	if p.ShadowLift {
		gamma = min(gamma+shadowLift, 100)
	}
	return [][2]string{
		{"brightness", strconv.Itoa(p.Brightness)},
		{"contrast", strconv.Itoa(p.Contrast)},
		{"saturation", strconv.Itoa(p.Saturation)},
		{"gamma", strconv.Itoa(gamma)},
		{"hue", strconv.Itoa(p.Hue)},
	}
}

// adjustments is where Load finds a title's picture when the call doesn't
// name one: the store, which UseSettings gives the player in the app.
type adjustments interface {
	ProfileSettings(profileID uint64) (store.ProfileSettings, error)
	TitleAdjustments(profileID uint64, contentID string) (*store.TitleAdjustments, error)
}

// adjustmentsFor reads what Watching's profile and title say a file plays
// with, from the store; nil for what isn't there (no store, no Watching, a
// read that failed).
func (s *Service) adjustmentsFor(opts LoadOptions) (*store.TitleAdjustments, *store.ProfileSettings) {
	s.mu.Lock()
	settings := s.settings
	s.mu.Unlock()
	a, ok := settings.(adjustments)
	w := opts.Watching
	if !ok || w == nil || w.ProfileID == 0 {
		return nil, nil
	}
	title, err := a.TitleAdjustments(w.ProfileID, w.ContentID)
	if err != nil {
		slog.Warn("player: title adjustments unread", "error", err)
		title = nil
	}
	profile, err := a.ProfileSettings(w.ProfileID)
	if err != nil {
		slog.Warn("player: profile settings unread", "error", err)
		return title, nil
	}
	return title, &profile
}

// pictureFor is the picture a file plays with: the one opts names, else the
// title's own, else its profile's default, else the file as it is. Reading
// it here means every way a file starts (the picker, the next episode, the
// switcher, a reload) gets it.
func (s *Service) pictureFor(opts LoadOptions) store.Picture {
	if opts.Picture != nil {
		return *opts.Picture
	}
	title, profile := s.adjustmentsFor(opts)
	if title != nil && title.Picture != nil && title.Picture.Valid() {
		return *title.Picture
	}
	if profile != nil && profile.Picture.Valid() {
		return profile.Picture
	}
	return store.DefaultPicture()
}

// SetPicture adjusts the picture from now on: the Picture & sound sheet's
// sliders call it as they move.
func (s *Service) SetPicture(picture store.Picture) error {
	if !picture.Valid() {
		return ErrInvalid
	}
	for _, p := range pictureProps(picture) {
		if err := s.set(p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}
