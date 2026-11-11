package store

import "slices"

// Quality is how hard the renderer works on the picture: the scalers,
// debanding, sharpening, an upscaling shader, motion smoothing,
// deinterlacing and HDR tone mapping. It depends on the GPU, so the
// default is the device's (DeviceSettings); a title may have its own
// (TitleAdjustments), like Anime4K for one show.
type Quality struct {
	// Scaling is one of ScalingPresets: mpv's fast profile, its defaults,
	// or its high-quality profile.
	Scaling string `json:"scaling"`
	// Deband is one of DebandLevels.
	Deband string `json:"deband"`
	// Sharpen is AMD's CAS strength in tenths, 0 (off) to 10.
	Sharpen int `json:"sharpen"`
	// Upscaler is one of Upscalers: a shader for video smaller than the
	// window.
	Upscaler string `json:"upscaler"`
	// MotionSmoothing shows frames in step with the display, blending
	// between them: smoother pans, and the soap-opera look.
	MotionSmoothing bool `json:"motionSmoothing"`
	// Deinterlace is one of DeinterlaceModes.
	Deinterlace string `json:"deinterlace"`
	// ToneMapping is one of ToneMappings, for HDR on a screen that can't
	// show it; TargetPeak is that screen's brightness in nits, 0 for mpv's
	// guess.
	ToneMapping string `json:"toneMapping"`
	TargetPeak  int    `json:"targetPeak"`
}

var (
	ScalingPresets   = []string{"fast", "balanced", "high"}
	DebandLevels     = []string{"off", "low", "medium", "high"}
	Upscalers        = []string{"off", "fsr", "anime4k"}
	DeinterlaceModes = []string{"auto", "on", "off"}
	ToneMappings     = []string{"auto", "bt.2390", "spline", "hable", "mobius", "clip"}
	// MinTargetPeak and MaxTargetPeak bound TargetPeak, other than 0.
	MinTargetPeak, MaxTargetPeak = 80, 1000
)

// DefaultQuality is mpv's own rendering, deinterlacing what says it's
// interlaced.
func DefaultQuality() Quality {
	return Quality{Scaling: "balanced", Deband: "off", Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto"}
}

// Valid reports whether q's choices are known and its numbers in range.
func (q Quality) Valid() bool {
	return slices.Contains(ScalingPresets, q.Scaling) && slices.Contains(DebandLevels, q.Deband) &&
		q.Sharpen >= 0 && q.Sharpen <= 10 && slices.Contains(Upscalers, q.Upscaler) &&
		slices.Contains(DeinterlaceModes, q.Deinterlace) && slices.Contains(ToneMappings, q.ToneMapping) &&
		(q.TargetPeak == 0 || (q.TargetPeak >= MinTargetPeak && q.TargetPeak <= MaxTargetPeak))
}
