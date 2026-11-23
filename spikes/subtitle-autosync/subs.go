package main

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Cue is one subtitle line, in ms.
type Cue struct {
	Start, End int64
	Text       string
}

var (
	srtTime = regexp.MustCompile(`(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})`)
	vttTime = regexp.MustCompile(`(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})`)
	assTime = regexp.MustCompile(`^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$`)
	tags    = regexp.MustCompile(`\{[^}]*\}|<[^>]*>`)
)

func ms(h, m, s, frac string) int64 {
	hh, _ := strconv.ParseInt(h, 10, 64)
	mm, _ := strconv.ParseInt(m, 10, 64)
	ss, _ := strconv.ParseInt(s, 10, 64)
	f, _ := strconv.ParseInt(frac, 10, 64)
	switch len(frac) {
	case 1:
		f *= 100
	case 2:
		f *= 10
	}
	return ((hh*60+mm)*60+ss)*1000 + f
}

// ParseSubtitle reads SRT, WebVTT or ASS/SSA. Unknown formats give no cues.
func ParseSubtitle(data []byte) []Cue {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(data) {
		// Latin-1 fallback: times are ASCII either way.
		r := make([]rune, len(data))
		for i, b := range data {
			r[i] = rune(b)
		}
		data = []byte(string(r))
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if strings.Contains(text, "[Events]") {
		return parseASS(text)
	}
	re := srtTime
	if strings.HasPrefix(strings.TrimSpace(text), "WEBVTT") {
		re = vttTime
	}
	var out []Cue
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); i++ {
		m := re.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		var c Cue
		if re == vttTime {
			c.Start, c.End = ms(m[1], m[2], m[3], m[4]), ms(m[5], m[6], m[7], m[8])
		} else {
			c.Start, c.End = ms(m[1], m[2], m[3], m[4]), ms(m[5], m[6], m[7], m[8])
		}
		var body []string
		for i+1 < len(lines) && strings.TrimSpace(lines[i+1]) != "" {
			i++
			body = append(body, lines[i])
		}
		c.Text = clean(strings.Join(body, " "))
		if c.End > c.Start {
			out = append(out, c)
		}
	}
	return out
}

func parseASS(text string) []Cue {
	var out []Cue
	format := []string{"layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"}
	inEvents := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inEvents = strings.EqualFold(line, "[Events]")
			continue
		}
		if !inEvents {
			continue
		}
		if f, ok := strings.CutPrefix(line, "Format:"); ok {
			format = nil
			for _, p := range strings.Split(f, ",") {
				format = append(format, strings.ToLower(strings.TrimSpace(p)))
			}
			continue
		}
		rest, ok := strings.CutPrefix(line, "Dialogue:")
		if !ok {
			continue
		}
		parts := strings.SplitN(strings.TrimSpace(rest), ",", len(format))
		if len(parts) != len(format) {
			continue
		}
		var c Cue
		for i, name := range format {
			switch name {
			case "start", "end":
				m := assTime.FindStringSubmatch(strings.TrimSpace(parts[i]))
				if m == nil {
					continue
				}
				v := ms(m[1], m[2], m[3], m[4])
				if name == "start" {
					c.Start = v
				} else {
					c.End = v
				}
			case "text":
				c.Text = clean(strings.ReplaceAll(parts[i], `\N`, " "))
			}
		}
		if c.End > c.Start {
			out = append(out, c)
		}
	}
	sortCues(out)
	return out
}

func sortCues(c []Cue) {
	// insertion sort is fine: ASS is mostly ordered already
	for i := 1; i < len(c); i++ {
		for j := i; j > 0 && c[j].Start < c[j-1].Start; j-- {
			c[j], c[j-1] = c[j-1], c[j]
		}
	}
}

func clean(s string) string {
	s = tags.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, `\N`, " ")
	s = strings.ReplaceAll(s, `\n`, " ")
	return strings.Join(strings.Fields(s), " ")
}

// words normalises text for the ground-truth text match: lower case,
// letters and digits only.
func words(s string) []string {
	s = clean(s)
	f := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\''
	})
	out := f[:0]
	for _, w := range f {
		w = strings.Trim(w, "'")
		if w != "" {
			out = append(out, w)
		}
	}
	return out
}
