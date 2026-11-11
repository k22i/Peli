package player

import (
	"fmt"
	"regexp"
	"runtime"
	"slices"
	"strconv"
)

// SubtitleStyle is how text subtitles look: the profile's choice,
// applied at every load and changed live from the player. Subtitles that
// bring their own styling (ASS) keep it unless Override is on.
type SubtitleStyle struct {
	// Font is "sans", "serif" or "mono": a face this OS has for each.
	Font string `json:"font"`
	// Size is a percentage of mpv's own size, 50–200.
	Size int `json:"size"`
	// Color is the text's "#RRGGBB".
	Color string `json:"color"`
	// Edge is how the text stands off the picture: "none", "outline",
	// "shadow" or "box".
	Edge string `json:"edge"`
	// Backdrop is the box's opacity for Edge "box", 0–100.
	Backdrop int `json:"backdrop"`
	// Lift raises the subtitles from their usual place, in percent of the
	// picture's height, 0–30.
	Lift int  `json:"lift"`
	Bold bool `json:"bold"`
	// Override restyles subtitles that bring their own styling too.
	Override bool `json:"override"`
}

// SubtitleFonts and SubtitleEdges are a SubtitleStyle's choices.
var (
	SubtitleFonts = []string{"sans", "serif", "mono"}
	SubtitleEdges = []string{"none", "outline", "shadow", "box"}
	hexRGB        = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
)

// fontNames are the faces mpv asks the OS for, by Font. Each OS has them
// installed; libass falls back to its default for a missing one.
var fontNames = map[string]map[string]string{
	"darwin":  {"sans": "Helvetica Neue", "serif": "Georgia", "mono": "Menlo"},
	"windows": {"sans": "Segoe UI", "serif": "Georgia", "mono": "Consolas"},
	"linux":   {"sans": "Sans", "serif": "Serif", "mono": "Monospace"},
}

func (st SubtitleStyle) valid() bool {
	return slices.Contains(SubtitleFonts, st.Font) && st.Size >= 50 && st.Size <= 200 &&
		hexRGB.MatchString(st.Color) && slices.Contains(SubtitleEdges, st.Edge) &&
		st.Backdrop >= 0 && st.Backdrop <= 100 && st.Lift >= 0 && st.Lift <= 30
}

// props are the mpv properties that draw st, set in this order.
func (st SubtitleStyle) props() [][2]string {
	fonts := fontNames[runtime.GOOS]
	if fonts == nil {
		fonts = fontNames["linux"]
	}
	yes := func(on bool) string {
		if on {
			return "yes"
		}
		return "no"
	}
	override := "scale" // mpv's default: styled subtitles keep their look
	if st.Override {
		override = "force"
	}
	props := [][2]string{
		{"sub-font", fonts[st.Font]},
		{"sub-scale", seconds(float64(st.Size) / 100)},
		{"sub-color", st.Color},
		{"sub-bold", yes(st.Bold)},
		{"sub-pos", strconv.Itoa(100 - st.Lift)},
		{"sub-ass-override", override},
	}
	// mpv colours with alpha are "#AARRGGBB".
	switch st.Edge {
	case "none":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "0"}, [2]string{"sub-shadow-offset", "0"})
	case "outline":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "2.6"}, [2]string{"sub-outline-color", "#FF000000"},
			[2]string{"sub-shadow-offset", "0"})
	case "shadow":
		props = append(props, [2]string{"sub-border-style", "outline-and-shadow"},
			[2]string{"sub-outline-size", "0.6"}, [2]string{"sub-outline-color", "#99000000"},
			[2]string{"sub-shadow-offset", "2"}, [2]string{"sub-shadow-color", "#B0000000"})
	case "box":
		props = append(props, [2]string{"sub-border-style", "background-box"},
			[2]string{"sub-outline-size", "4"}, [2]string{"sub-shadow-offset", "0"},
			[2]string{"sub-back-color", fmt.Sprintf("#%02X000000", st.Backdrop*255/100)})
	}
	return props
}

// SetSubtitleStyle draws text subtitles in style from now on.
func (s *Service) SetSubtitleStyle(style SubtitleStyle) error {
	if !style.valid() {
		return ErrInvalid
	}
	for _, p := range style.props() {
		if err := s.set(p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}
