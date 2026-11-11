package store

import "slices"

// Sound is how a title sounds: dialogue lifted, loud and quiet evened out
// for late at night, and an equalizer preset. A profile has a default; a
// title may have its own (TitleAdjustments).
type Sound struct {
	DialogueBoost bool `json:"dialogueBoost"`
	NightMode     bool `json:"nightMode"`
	// Equalizer is one of EqualizerPresets.
	Equalizer string `json:"equalizer"`
}

// Audio is this device's output: which device, a stereo downmix for
// speakers or headphones that are stereo, and how loud the player may go.
type Audio struct {
	// Device is mpv's audio-device name ("coreaudio/<uid>"), or "auto" for
	// the system's.
	Device string `json:"device"`
	// StereoDownmix mixes surround tracks down to stereo before output.
	StereoDownmix bool `json:"stereoDownmix"`
	// VolumeBoost lets the volume go to 150 % (mpv's volume-max).
	VolumeBoost bool `json:"volumeBoost"`
}

var EqualizerPresets = []string{"flat", "bass", "treble", "voice", "loudness"}

// MaxAudioDevice bounds Audio.Device, in bytes.
const MaxAudioDevice = 512

// DefaultSound is the track as it is.
func DefaultSound() Sound { return Sound{Equalizer: "flat"} }

// DefaultAudio is the system's device, as many channels as it takes, up to
// 100 %.
func DefaultAudio() Audio { return Audio{Device: "auto"} }

// Valid reports whether s's equalizer preset is known.
func (s Sound) Valid() bool { return slices.Contains(EqualizerPresets, s.Equalizer) }

// Valid reports whether a names a device.
func (a Audio) Valid() bool { return a.Device != "" && len(a.Device) <= MaxAudioDevice }
