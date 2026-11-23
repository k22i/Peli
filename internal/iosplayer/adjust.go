//go:build ios

package iosplayer

import (
	"log/slog"
	"math"
	"strconv"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// How a title's picture, framing, quality and sound reach mpv on iOS. The
// rules are playback's (internal/playback/adjust.go), the desktop player's
// too, so a title looks and sounds the same on both.
//
// What iOS leaves out, and why: panscan, which the touch player's pinch owns
// (SetPanscan); the crop, which is video-crop (applyCrop), not a filter, mpv's
// vf being where the flips are a filter and where the decoding mode's 8-bit
// chain lives (filterFor); motion smoothing, deinterlacing and the shaders
// (glsl-shaders carries the chroma fix, chroma.go); and the audio device, a
// phone having one output. Auto-crop is the desktop's (autocrop.go), the same
// schedule and measuring over this engine's frames.

// adjustments is where a Load finds a title's picture, framing, quality and
// sound when the call doesn't name them: the store, which the app hands the
// engine as its Settings (main_ios.go). A Settings without it, a test fake,
// just gets the defaults.
type adjustments interface {
	ProfileSettings(profileID uint64) (store.ProfileSettings, error)
	TitleAdjustments(profileID uint64, contentID string) (*store.TitleAdjustments, error)
}

// adjustmentsFor reads what Watching's profile and title say a file plays
// with, from the store; nil for what isn't there (no store, no Watching, a
// read that failed).
func (e *Engine) adjustmentsFor(w *playback.Watching) (*store.TitleAdjustments, *store.ProfileSettings) {
	a, ok := e.settings.(adjustments)
	if !ok || w == nil || w.ProfileID == 0 {
		return nil, nil
	}
	title, err := a.TitleAdjustments(w.ProfileID, w.ContentID)
	if err != nil {
		slog.Warn("iosplayer: title adjustments unread", "error", err)
		title = nil
	}
	profile, err := a.ProfileSettings(w.ProfileID)
	if err != nil {
		slog.Warn("iosplayer: profile settings unread", "error", err)
		return title, nil
	}
	return title, &profile
}

// deviceSettings is this device's settings, from the store; nil when there is
// none, or the read fails.
func (e *Engine) deviceSettings() *store.DeviceSettings {
	if e.settings == nil {
		return nil
	}
	d, err := e.settings.DeviceSettings()
	if err != nil {
		slog.Warn("iosplayer: device settings unread", "error", err)
		return nil
	}
	return &d
}

// adjustProps are the mpv properties a new file starts with: its picture,
// framing, quality, sound and audio delay, resolved as the desktop resolves
// them (what opts names, else the title's, else the profile's or this
// device's). The framing is kept, for the crop the video's size completes
// (applyCrop). iOS shows no HDR as HDR, so tone mapping is for an SDR screen.
func (e *Engine) adjustProps(opts playback.LoadOptions) [][2]string {
	// This device's settings are always read: the sound output needs them,
	// and opts names no audio. The profile's and title's only when opts
	// names no picture, framing, quality or sound.
	device := e.deviceSettings()
	var title *store.TitleAdjustments
	var profile *store.ProfileSettings
	if opts.Picture == nil || opts.Framing == nil || opts.Quality == nil || opts.Sound == nil {
		title, profile = e.adjustmentsFor(opts.Watching)
	}
	picture := playback.PictureOf(opts.Picture, title, profile)
	framing := playback.FramingOf(opts.Framing, title, profile)
	quality := playback.QualityOf(opts.Quality, title, device)
	sound := playback.SoundOf(opts.Sound, title, profile)
	audio := playback.AudioOf(device)
	e.mu.Lock()
	e.framing = framing
	e.mu.Unlock()

	props := playback.PictureProps(picture)
	props = append(props, playback.FramingProps(framing)...)
	props = append(props, playback.ScalingProps(quality)...)
	props = append(props, playback.ToneProps(quality, false)...)
	return append(props,
		[2]string{"audio-channels", playback.AudioChannels(audio.StereoDownmix)},
		[2]string{"af", playback.SoundChain(sound)},
		// A new file plays in sync, as its subtitles do.
		[2]string{"audio-delay", "0"},
		// The crop waits for the video's size (applyCrop).
		[2]string{"video-crop", ""})
}

// applyCrop sets the crop the framing asks for, once the video's size is
// known: the manual one, or what auto-crop finds (it starts looking).
func (e *Engine) applyCrop(ses *session) {
	e.mu.Lock()
	f, w, h, load := e.framing, e.videoW, e.videoH, e.loads
	e.mu.Unlock()
	if w <= 0 || h <= 0 {
		return
	}
	if f.AutoCrop {
		e.startAutoCrop(ses, load)
		return
	}
	e.stopAutoCrop()
	e.update(func(st *playback.State) { st.AutoCrop = nil })
	if err := ses.m.setProperty("video-crop", playback.CropProp(f.Crop, w, h)); err != nil {
		slog.Warn("iosplayer: crop not set", "error", err)
	}
}

// SetPicture adjusts the picture from now on: the Picture & sound sheet's
// sliders call it as they move.
func (e *Engine) SetPicture(p store.Picture) error {
	if !p.Valid() {
		return playback.ErrInvalid
	}
	if e.current() == nil {
		return playback.ErrNotPlaying
	}
	for _, prop := range playback.PictureProps(p) {
		if err := e.set(prop[0], prop[1]); err != nil {
			return err
		}
	}
	return nil
}

// SetFraming frames the picture from now on: the sheet's framing tab and the
// touch player's own gestures call it.
func (e *Engine) SetFraming(f store.Framing) error {
	if !f.Valid() {
		return playback.ErrInvalid
	}
	ses := e.current()
	if ses == nil {
		return playback.ErrNotPlaying
	}
	for _, prop := range playback.FramingProps(f) {
		if err := ses.m.setProperty(prop[0], prop[1]); err != nil {
			return notPlaying(err)
		}
	}
	e.mu.Lock()
	e.framing = f
	e.mu.Unlock()
	e.applyCrop(ses)
	return nil
}

// SetQuality renders the picture with q from now on: the sheet's quality tab
// calls it. The scalers and debanding, then tone mapping: no shader, no
// motion smoothing, no deinterlacing.
func (e *Engine) SetQuality(q store.Quality) error {
	if !q.Valid() {
		return playback.ErrInvalid
	}
	if e.current() == nil {
		return playback.ErrNotPlaying
	}
	props := playback.ScalingProps(q)
	props = append(props, playback.ToneProps(q, false)...)
	for _, prop := range props {
		if err := e.set(prop[0], prop[1]); err != nil {
			return err
		}
	}
	return nil
}

// SetSound changes how the file sounds from now on: the sheet's sound tab
// calls it. A filter this build lacks leaves the sound as it is, rather than
// silent.
func (e *Engine) SetSound(s store.Sound) error {
	if !s.Valid() {
		return playback.ErrInvalid
	}
	if e.current() == nil {
		return playback.ErrNotPlaying
	}
	if err := e.set("af", playback.SoundChain(s)); err != nil {
		_ = e.set("af", "")
		return err
	}
	return nil
}

// SetAudio changes this device's output from now on (the setting is saved by
// the caller): only how many channels, a phone having one output.
func (e *Engine) SetAudio(a store.Audio) error {
	if !a.Valid() {
		return playback.ErrInvalid
	}
	if e.current() == nil {
		return playback.ErrNotPlaying
	}
	return e.set("audio-channels", playback.AudioChannels(a.StereoDownmix))
}

// SetAudioDelay moves the sound later (positive) or earlier than the picture,
// for this session: a track out of sync is the file's, not a setting. It is
// bounded like the desktop's, ±10 s.
func (e *Engine) SetAudioDelay(d float64) error {
	if !finite(d) || math.Abs(d) > 10 {
		return playback.ErrInvalid
	}
	return e.set("audio-delay", strconv.FormatFloat(d, 'f', 3, 64))
}
