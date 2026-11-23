package main

import (
	"fmt"
	"regexp"
	"strings"
)

// Retime rewrites every timestamp in an SRT, WebVTT or ASS file with
// shift(t) (ms to add at candidate time t), leaving everything else (text,
// styles, tags) as it was. A line pushed before 0 starts at 0.
func Retime(data []byte, shift func(int64) float64) []byte {
	text := string(data)
	if strings.Contains(text, "[Events]") {
		return []byte(retimeASS(text, shift))
	}
	return []byte(srtTimeLine.ReplaceAllStringFunc(text, func(line string) string {
		m := srtTimeLine.FindStringSubmatch(line)
		sep := ","
		if strings.Contains(m[1], ".") {
			sep = "."
		}
		a, b := parseClock(m[1]), parseClock(m[3])
		na := clampMs(float64(a) + shift(a))
		nb := clampMs(float64(b) + shift(a)) // keep each line's duration
		return clock(na, sep, 3) + m[2] + clock(nb, sep, 3) + m[4]
	}))
}

var (
	srtTimeLine = regexp.MustCompile(`((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})(\s*-->\s*)((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})([^\n]*)`)
	assDialogue = regexp.MustCompile(`(?m)^(Dialogue:\s*[^,]*,)(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2})`)
)

func parseClock(s string) int64 {
	s = strings.ReplaceAll(s, ",", ".")
	var h, m, sec, frac int64
	parts := strings.Split(s, ":")
	if len(parts) == 2 {
		parts = append([]string{"0"}, parts...)
	}
	fmt.Sscan(parts[0], &h)
	fmt.Sscan(parts[1], &m)
	sp := strings.SplitN(parts[2], ".", 2)
	fmt.Sscan(sp[0], &sec)
	if len(sp) == 2 {
		fmt.Sscan(sp[1], &frac)
		for i := len(sp[1]); i < 3; i++ {
			frac *= 10
		}
	}
	return ((h*60+m)*60+sec)*1000 + frac
}

func clampMs(v float64) int64 {
	if v < 0 {
		return 0
	}
	return int64(v + 0.5)
}

func clock(ms int64, sep string, digits int) string {
	h, ms := ms/3_600_000, ms%3_600_000
	m, ms := ms/60_000, ms%60_000
	s, ms := ms/1000, ms%1000
	if digits == 2 {
		return fmt.Sprintf("%d:%02d:%02d%s%02d", h, m, s, sep, ms/10)
	}
	return fmt.Sprintf("%02d:%02d:%02d%s%03d", h, m, s, sep, ms)
}

func retimeASS(text string, shift func(int64) float64) string {
	return assDialogue.ReplaceAllStringFunc(text, func(line string) string {
		m := assDialogue.FindStringSubmatch(line)
		a, b := parseClock(m[2]), parseClock(m[3])
		na := clampMs(float64(a) + shift(a))
		nb := clampMs(float64(b) + shift(a))
		return m[1] + clock(na, ".", 2) + "," + clock(nb, ".", 2)
	})
}
