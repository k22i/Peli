package playback

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/k22i/Peli/internal/store"
)

// How a file's picture, framing, quality and sound look and sound, as mpv
// properties and filter chains: the rules both engines apply (the desktop
// player in internal/player and the iOS one, ADR-0055). They are pure and
// have no cgo, like the rest of this package, and they keep the store's
// types: one rule, one place, the same names, values and order on both.

// shadowLift is how far ShadowLift raises gamma: enough to open up a dark
// scene's shadows without washing out a bright one.
const shadowLift = 15

// PictureProps are the mpv properties that adjust the picture as p says.
// They are the VO's equalizer: the renderer applies them in its colour
// matrix (macOS's gpu renderer and Windows' gpu-next alike), so they cost
// nothing and hardware decoding stays zero-copy. Hue only moves YUV video.
func PictureProps(p store.Picture) [][2]string {
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

// FramingProps are the mpv properties that frame the picture as f says, but
// the panscan a fill asks for (FramingPanscan), the crop, which needs the
// video's size (CropProp), and the flips, which are a filter (FlipFilter).
// They are the renderer's, keeping hardware-decoded frames on the GPU; iOS
// takes these and leaves panscan, the crop and the flips out.
func FramingProps(f store.Framing) [][2]string {
	keepaspect, unscaled := "yes", "no"
	switch f.Fit {
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
	num := func(v float64) string { return strconv.FormatFloat(v, 'f', 4, 64) }
	return [][2]string{
		{"keepaspect", keepaspect},
		{"video-unscaled", unscaled},
		{"video-aspect-override", aspect},
		{"video-zoom", num(f.Zoom)},
		{"video-pan-x", num(f.PanX)},
		{"video-pan-y", num(f.PanY)},
		{"video-rotate", strconv.Itoa(f.Rotate)},
	}
}

// FramingPanscan is mpv's panscan for f: "1" fills the window with the
// picture, cropping what hangs over, "0" shows it whole. It is not a filter
// (it crops the renderer's output), but it zooms without asking, so it stays
// its own property for iOS.
func FramingPanscan(f store.Framing) string {
	if f.Fit == "fill" {
		return "1"
	}
	return "0"
}

// FlipFilter is mpv's vf for f's flips, or "" for none. A flip is lavfi's
// hflip or vflip, which copies a hardware-decoded frame off the GPU, so it's
// only there while asked for.
func FlipFilter(f store.Framing) string {
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
	return vf
}

// CropProp is mpv's video-crop for crop on a w×h video, in its pixels: ""
// (the container's own crop, if any) when it cuts nothing. A percent offset
// in mpv's rect means a share of the space left over, so it's computed here.
func CropProp(crop store.Crop, w, h int) string {
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

// debandSteps are mpv's deband-iterations, -threshold, -range and -grain
// for each DebandLevel: low is lighter than mpv's own, high clears heavy
// banding (and some fine texture with it).
var debandSteps = map[string][4]string{
	"low":    {"1", "32", "16", "24"},
	"medium": {"2", "48", "16", "32"},
	"high":   {"4", "64", "20", "48"},
}

// scalingProps are mpv's fast profile, its defaults (0.41), and its
// high-quality profile (etc/builtin.conf). Rendering 1080p to a 4K frame
// on an M1 Pro (build/libmpv/smoke/bench_darwin.c): 2.1, 5.6 and 14.3 ms.
var scalingProps = map[string][][2]string{
	"fast": {{"scale", "bilinear"}, {"dscale", "bilinear"}, {"dither", "no"},
		{"correct-downscaling", "no"}, {"linear-downscaling", "no"}, {"sigmoid-upscaling", "no"}},
	"balanced": {{"scale", "lanczos"}, {"dscale", "hermite"}, {"dither", "fruit"},
		{"correct-downscaling", "yes"}, {"linear-downscaling", "yes"}, {"sigmoid-upscaling", "yes"}},
	"high": {{"scale", "ewa_lanczossharp"}, {"dscale", "hermite"}, {"dither", "fruit"},
		{"correct-downscaling", "yes"}, {"linear-downscaling", "yes"}, {"sigmoid-upscaling", "yes"}},
}

// ScalingProps are mpv's properties for q's scalers and debanding: the
// rendering, no filter and nothing that needs a shader. iOS takes these and
// leaves out motion smoothing, deinterlacing and the shaders, which are the
// desktop's.
func ScalingProps(q store.Quality) [][2]string {
	props := append([][2]string{}, scalingProps[q.Scaling]...)
	if steps, ok := debandSteps[q.Deband]; ok {
		props = append(props, [2]string{"deband", "yes"}, [2]string{"deband-iterations", steps[0]},
			[2]string{"deband-threshold", steps[1]}, [2]string{"deband-range", steps[2]},
			[2]string{"deband-grain", steps[3]})
	} else {
		props = append(props, [2]string{"deband", "no"})
	}
	return props
}

// ToneProps are q's HDR tone mapping, mpv's or the set one: tone-mapping
// then target-peak. hdrOut is whether the session shows HDR as HDR (the EDR
// layer): tone mapping is for SDR screens, so it's left to mpv then. They
// come last, and alone: showing HDR sets just these two.
func ToneProps(q store.Quality, hdrOut bool) [][2]string {
	tone, peak := q.ToneMapping, "auto"
	if q.TargetPeak > 0 {
		peak = strconv.Itoa(q.TargetPeak)
	}
	if hdrOut {
		tone, peak = "auto", "auto"
	}
	return [][2]string{{"tone-mapping", tone}, {"target-peak", peak}}
}

// The sound is one lavfi chain in mpv's af, from filters in our LGPL build
// (build/libmpv/build.sh): dialoguenhance lifts the centre (speech) of a
// stereo mix (lavfi downmixes surround to stereo first, so a 5.1 track
// comes out of the front); the equalizer presets are af_biquads'; night
// mode is dynaudnorm, which evens loud and quiet within half a second.
// loudnorm was the other candidate: about 25 times the CPU (60 s of 5.1 in
// 5.3 s against 0.2–0.4 s) and a 3 s lookahead, which delays sound after
// every seek.

const (
	dialogueFilter = "dialoguenhance=original=1:enhance=2:voice=2"
	nightFilter    = "dynaudnorm=f=150:g=7:p=0.9:m=10"
)

// eqFilters are each preset's filters; the boosting ones start with a cut,
// so their peaks have room (there's no limiter in the build).
var eqFilters = map[string][]string{
	"flat":   nil,
	"bass":   {"volume=-5dB", "bass=g=6:f=100:w=0.6"},
	"treble": {"volume=-4dB", "treble=g=5:f=6000:w=0.6"},
	// Speech forward: less rumble, more presence.
	"voice":    {"volume=-3dB", "bass=g=-4:f=150:w=0.6", "equalizer=f=2500:t=q:w=1:g=4", "equalizer=f=5000:t=q:w=1.2:g=2"},
	"loudness": {"volume=-4dB", "bass=g=5:f=90:w=0.6", "treble=g=3:f=8000:w=0.6"},
}

// SoundChain is mpv's af for s: "" for the track as it is.
func SoundChain(s store.Sound) string {
	var chain []string
	if s.DialogueBoost {
		chain = append(chain, dialogueFilter)
	}
	chain = append(chain, eqFilters[s.Equalizer]...)
	if s.NightMode {
		chain = append(chain, nightFilter)
	}
	if len(chain) == 0 {
		return ""
	}
	return "@peli-sound:lavfi=[" + strings.Join(chain, ",") + "]"
}

// AudioChannels is mpv's audio-channels for this device: downmixed to
// stereo for stereo speakers and headphones, or as many channels as the
// file has.
func AudioChannels(stereo bool) string {
	if stereo {
		return "stereo"
	}
	return "auto-safe"
}

// PictureOf is the picture a file plays with: the one named, else the
// title's own, else its profile's default, else the file as it is. Reading
// it from the store's adjustments means every way a file starts (the
// picker, the next episode, the switcher, a reload) gets it.
func PictureOf(named *store.Picture, title *store.TitleAdjustments, profile *store.ProfileSettings) store.Picture {
	if named != nil {
		return *named
	}
	if title != nil && title.Picture != nil && title.Picture.Valid() {
		return *title.Picture
	}
	if profile != nil && profile.Picture.Valid() {
		return profile.Picture
	}
	return store.DefaultPicture()
}

// FramingOf is the framing a file plays with: the one named, else the
// title's own, else the profile's fit and auto-crop (a profile has those
// two only).
func FramingOf(named *store.Framing, title *store.TitleAdjustments, profile *store.ProfileSettings) store.Framing {
	if named != nil {
		return *named
	}
	if title != nil && title.Framing != nil && title.Framing.Valid() {
		return *title.Framing
	}
	f := store.DefaultFraming()
	if profile != nil && profile.Framing.Valid() {
		f.Fit, f.AutoCrop = profile.Framing.Fit, profile.Framing.AutoCrop
	}
	return f
}

// SoundOf is the sound a file plays with: the one named, else the title's
// own, else its profile's.
func SoundOf(named *store.Sound, title *store.TitleAdjustments, profile *store.ProfileSettings) store.Sound {
	if named != nil {
		return *named
	}
	if title != nil && title.Sound != nil && title.Sound.Valid() {
		return *title.Sound
	}
	if profile != nil && profile.Sound.Valid() {
		return profile.Sound
	}
	return store.DefaultSound()
}

// QualityOf is the quality a file plays with: the one named, else the
// title's own, else this device's (device is nil when it can't be read).
func QualityOf(named *store.Quality, title *store.TitleAdjustments, device *store.DeviceSettings) store.Quality {
	if named != nil {
		return *named
	}
	if title != nil && title.Quality != nil && title.Quality.Valid() {
		return *title.Quality
	}
	if device != nil && device.Quality.Valid() {
		return device.Quality
	}
	return store.DefaultQuality()
}

// AudioOf is this device's output: device is nil when the settings can't be
// read.
func AudioOf(device *store.DeviceSettings) store.Audio {
	if device != nil && device.Audio.Valid() {
		return device.Audio
	}
	return store.DefaultAudio()
}
