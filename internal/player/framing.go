//go:build !ios

package player

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strconv"

	"github.com/k22i/Peli/internal/store"
)

// framingProps are the mpv properties that frame the picture as f says,
// but the crop, which needs the video's size (cropProp). All are the
// renderer's but vf: a flip is lavfi's hflip or vflip, which copies a
// hardware-decoded frame off the GPU, so it's only there while asked for.
func framingProps(f store.Framing) [][2]string {
	keepaspect, panscan, unscaled := "yes", "0", "no"
	switch f.Fit {
	case "fill":
		panscan = "1"
	case "stretch":
		keepaspect = "no"
	case "original":
		// Its own size, unless that's bigger than the window.
		unscaled = "downscale-big"
	}
	aspect := "-1" // the file's own
	if f.Aspect != "auto" && f.Aspect != "" {
		aspect = f.Aspect
	}
	vf := ""
	if f.FlipH {
		vf = "@peli-hflip:lavfi=[hflip]"
	}
	if f.FlipV {
		if vf != "" {
			vf += ","
		}
		vf += "@peli-vflip:lavfi=[vflip]"
	}
	num := func(v float64) string { return strconv.FormatFloat(v, 'f', 4, 64) }
	return [][2]string{
		{"keepaspect", keepaspect},
		{"panscan", panscan},
		{"video-unscaled", unscaled},
		{"video-aspect-override", aspect},
		{"video-zoom", num(f.Zoom)},
		{"video-pan-x", num(f.PanX)},
		{"video-pan-y", num(f.PanY)},
		{"video-rotate", strconv.Itoa(f.Rotate)},
		{"vf", vf},
	}
}

// cropProp is mpv's video-crop for crop on a w×h video, in its pixels: ""
// (the container's own crop, if any) when it cuts nothing. A percent offset
// in mpv's rect means a share of the space left over, so it's computed here.
func cropProp(crop store.Crop, w, h int) string {
	if crop.Empty() || w <= 0 || h <= 0 {
		return ""
	}
	px := func(percent float64, of int) int {
		// Even, so chroma subsampling lines up.
		return int(math.Round(percent/100*float64(of)/2)) * 2
	}
	left, right := px(crop.Left, w), px(crop.Right, w)
	top, bottom := px(crop.Top, h), px(crop.Bottom, h)
	cw, ch := w-left-right, h-top-bottom
	if cw < w/10 || ch < h/10 {
		return ""
	}
	return fmt.Sprintf("%dx%d+%d+%d", cw, ch, left, top)
}

// framingFor is the framing a file plays with: the one opts names, else the
// title's own, else the profile's fit and auto-crop.
func (s *Service) framingFor(opts LoadOptions) store.Framing {
	if opts.Framing != nil {
		return *opts.Framing
	}
	title, profile := s.adjustmentsFor(opts)
	if title != nil && title.Framing != nil && title.Framing.Valid() {
		return *title.Framing
	}
	f := store.DefaultFraming()
	if profile != nil && profile.Framing.Valid() {
		f.Fit, f.AutoCrop = profile.Framing.Fit, profile.Framing.AutoCrop
	}
	return f
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
	if err := ses.m.setProperty("video-crop", cropProp(f.Crop, w, h)); err != nil {
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
