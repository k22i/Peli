//go:build !ios

package player

import (
	"context"
	"log/slog"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// framingProps are the mpv properties that frame the picture as f says,
// but the crop, which needs the video's size (playback.CropProp). All are
// the renderer's but vf: a flip is lavfi's hflip or vflip, which copies a
// hardware-decoded frame off the GPU, so it's only there while asked for.
// The properties are playback's (the iOS engine frames with the same ones);
// the order here is the desktop's: panscan next to the fit it comes from,
// and the flips last.
func framingProps(f store.Framing) [][2]string {
	framing := playback.FramingProps(f)
	props := make([][2]string, 0, len(framing)+2)
	props = append(props, framing[0], [2]string{"panscan", playback.FramingPanscan(f)})
	props = append(props, framing[1:]...)
	return append(props, [2]string{"vf", playback.FlipFilter(f)})
}

// framingFor is the framing a file plays with: the one opts names, else the
// title's own, else the profile's fit and auto-crop.
func (s *Service) framingFor(opts LoadOptions) store.Framing {
	if opts.Framing != nil {
		return *opts.Framing
	}
	title, profile := s.adjustmentsFor(opts)
	return playback.FramingOf(nil, title, profile)
}

// SetFraming frames the picture from now on: the Picture & sound sheet and
// the framing keys call it.
func (s *Service) SetFraming(framing store.Framing) error {
	if !framing.Valid() {
		return ErrInvalid
	}
	ses := s.current()
	if ses == nil {
		return ErrNotPlaying
	}
	for _, p := range framingProps(framing) {
		if err := s.set(p[0], p[1]); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.framing = framing
	s.mu.Unlock()
	s.applyCrop(ses)
	return nil
}

// applyCrop sets the crop the framing asks for, once the video's size is
// known: the manual one, or what auto-crop finds (it starts looking).
func (s *Service) applyCrop(ses *session) {
	s.mu.Lock()
	f, w, h, file := s.framing, s.videoW, s.videoH, s.file
	s.mu.Unlock()
	if w <= 0 || h <= 0 {
		return
	}
	if f.AutoCrop {
		s.startAutoCrop(ses, file)
		return
	}
	s.stopAutoCrop()
	s.update(func(st *State) { st.AutoCrop = nil })
	if err := ses.m.setProperty("video-crop", playback.CropProp(f.Crop, w, h)); err != nil {
		slog.Warn("player: crop not set", "error", err)
	}
}

// startAutoCrop looks for black bars in the file playing, unless it is
// already. stopAutoCrop stops looking.
func (s *Service) startAutoCrop(ses *session, file uint64) {
	s.mu.Lock()
	if s.autoCrop != nil && s.autoCropFile == file {
		s.mu.Unlock()
		return
	}
	if s.autoCrop != nil {
		s.autoCrop()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.autoCrop, s.autoCropFile = cancel, file
	s.mu.Unlock()
	go s.findBars(ctx, ses, file)
}

func (s *Service) stopAutoCrop() {
	s.mu.Lock()
	if s.autoCrop != nil {
		s.autoCrop()
		s.autoCrop = nil
	}
	s.mu.Unlock()
}
