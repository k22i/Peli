package playback

import "strconv"

// MainImageSubtitle reports whether the main subtitle track in tracks (as
// TracksFrom maps mpv's track-list, before HideMainSubtitle) is pictures.
func MainImageSubtitle(tracks []Track) bool {
	for _, t := range tracks {
		if t.Type == "sub" && t.Selected && !t.Secondary {
			return ImageSubtitle(t.Codec)
		}
	}
	return false
}

// SubScale keeps mpv's sub-scale at the size the style asks for while the
// main subtitles are text, and at 1 while they are pictures. mpv 0.41 applies
// sub-scale to a picture subtitle too (sd_lavc.c, whenever sub-ass-override
// isn't "no"): it stretches the bitmap from its centre with linear
// filtering, which blurs it and thickens its edge, and none of the rest of
// the style reaches it. At 1 a Blu-ray subtitle is drawn as it was mastered.
// sub-pos still applies, so a lift that clears the controls moves it.
//
// The zero value wants mpv's own scale, 1. Engines keep one per session,
// under their state lock.
type SubScale struct {
	want  float64
	image bool
}

// value is the sub-scale mpv should have now.
func (s *SubScale) value() string {
	if s.image || s.want == 0 {
		return "1"
	}
	return Seconds(s.want)
}

// Props returns props with any sub-scale in them as the one mpv should get,
// and records the scale they asked for.
func (s *SubScale) Props(props [][2]string) [][2]string {
	out := make([][2]string, len(props))
	for i, p := range props {
		if p[0] == "sub-scale" {
			s.want = parseSeconds(p[1])
			p[1] = s.value()
		}
		out[i] = p
	}
	return out
}

// Load is Props for a new file's properties: its track-list hasn't come yet,
// so the subtitles count as text until Tracks says otherwise. When props
// don't size the subtitles, the scale the last file was asked for is set
// again, in case its picture subtitles left mpv at 1.
func (s *SubScale) Load(props [][2]string) [][2]string {
	s.image = false
	out := s.Props(props)
	for _, p := range out {
		if p[0] == "sub-scale" {
			return out
		}
	}
	return append(out, [2]string{"sub-scale", s.value()})
}

// Tracks notes which main subtitle track mpv shows. It returns the sub-scale
// to set, and true, when that turns from text to pictures or back.
func (s *SubScale) Tracks(tracks []Track) (string, bool) {
	image := MainImageSubtitle(tracks)
	if image == s.image {
		return "", false
	}
	s.image = image
	return s.value(), true
}

// Image reports whether the main subtitles are pictures, so sub-scale is held
// at 1: what mpv reports for it then isn't the size the style asks for.
func (s *SubScale) Image() bool { return s.image }

// parseSeconds reads a number Seconds wrote; 0 when it isn't one.
func parseSeconds(v string) float64 {
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	return f
}
