package store

import (
	"fmt"
	"slices"
	"strings"
)

// Picture is how the player adjusts the video: mpv's equalizer properties,
// applied in the renderer (no filter, so hardware decoding stays zero-copy).
// A profile has a default, a title may have its own (TitleAdjustments).
type Picture struct {
	// Preset names where the values came from: one of PicturePresets,
	// "custom" for values set by hand, or "user:<name>" for one of the
	// profile's NamedPictures. The values are what plays either way.
	Preset string `json:"preset"`
	// Each -100–100; 0 is the file as it is.
	Brightness int `json:"brightness"`
	Contrast   int `json:"contrast"`
	Saturation int `json:"saturation"`
	Gamma      int `json:"gamma"`
	Hue        int `json:"hue"`
	// ShadowLift raises the gamma of dark scenes' midtones a step, on top of
	// Gamma, for watching in daylight.
	ShadowLift bool `json:"shadowLift"`
}

// NamedPicture is a preset a profile saved under its own name.
type NamedPicture struct {
	Name    string  `json:"name"`
	Picture Picture `json:"picture"`
}

var (
	// PicturePresets are the built-in presets; the frontend holds their
	// values (lib/picture.ts).
	PicturePresets = []string{"standard", "vivid", "cinema", "anime"}
	// MaxNamedPictures is how many presets of its own a profile keeps.
	MaxNamedPictures = 8
	// MaxPresetName is a NamedPicture's longest name, in bytes.
	MaxPresetName = 40
)

// DefaultPicture is the file as it is.
func DefaultPicture() Picture { return Picture{Preset: "standard"} }

// Valid reports whether p's values are in range and its preset is known.
func (p Picture) Valid() bool {
	for _, v := range []int{p.Brightness, p.Contrast, p.Saturation, p.Gamma, p.Hue} {
		if v < -100 || v > 100 {
			return false
		}
	}
	name, user := strings.CutPrefix(p.Preset, "user:")
	switch {
	case user:
		return name != "" && len(name) <= MaxPresetName
	case p.Preset == "custom":
		return true
	default:
		return slices.Contains(PicturePresets, p.Preset)
	}
}

func validatePictures(picture Picture, named []NamedPicture) error {
	if !picture.Valid() {
		return fmt.Errorf("%w: picture %+v", ErrInvalidSettings, picture)
	}
	if len(named) > MaxNamedPictures {
		return fmt.Errorf("%w: %d picture presets", ErrInvalidSettings, len(named))
	}
	for i, n := range named {
		name := strings.TrimSpace(n.Name)
		if name == "" || name != n.Name || len(name) > MaxPresetName || !n.Picture.Valid() ||
			slices.ContainsFunc(named[:i], func(o NamedPicture) bool { return o.Name == n.Name }) {
			return fmt.Errorf("%w: picture preset %q", ErrInvalidSettings, n.Name)
		}
	}
	return nil
}
