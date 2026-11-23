package subsync

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

// The subtitle formats addons serve: SubRip, WebVTT and ASS/SSA. Only
// their times are read and rewritten; text, styles and tags stay as they
// are.

var (
	// SubRip and WebVTT: "00:01:02,500 --> 00:01:04,000" (WebVTT may drop
	// the hours and uses a dot).
	cueLine = regexp.MustCompile(`((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})([ \t]*-->[ \t]*)((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})`)
	// ASS: "Dialogue: 0,0:01:02.50,0:01:04.00,…"
	assLine = regexp.MustCompile(`(?m)^(Dialogue:[ \t]*[^,\r\n]*,)(\d+:\d{2}:\d{2}[.:]\d{1,3}),(\d+:\d{2}:\d{2}[.:]\d{1,3})`)
)

func isASS(data []byte) bool {
	return bytes.Contains(data, []byte("[Events]")) || bytes.Contains(data, []byte("[events]"))
}

// starts is the start of every line, in ms, sorted; ends their ends in the
// same order.
func lineTimes(data []byte) (starts, ends []int64) {
	re := cueLine
	if isASS(data) {
		re = assLine
	}
	for _, m := range re.FindAllSubmatch(data, -1) {
		a, b := m[1], m[3]
		if re == assLine {
			a, b = m[2], m[3]
		}
		start, end := clockMs(string(a)), clockMs(string(b))
		if start < 0 || end <= start {
			continue
		}
		starts = append(starts, start)
		ends = append(ends, end)
	}
	sortPairs(starts, ends)
	return starts, ends
}

func sortPairs(a, b []int64) {
	// Nearly sorted (ASS files are mostly in order): insertion sort.
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
			b[j], b[j-1] = b[j-1], b[j]
		}
	}
}

// clockMs reads "1:02:03,456", "02:03.456" or "0:02:03.45" as ms, or -1.
func clockMs(s string) int64 {
	s = strings.Replace(s, ",", ".", 1)
	frac := int64(0)
	if i := strings.LastIndexByte(s, '.'); i >= 0 {
		digits := s[i+1:]
		f, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			return -1
		}
		for n := len(digits); n < 3; n++ {
			f *= 10
		}
		frac, s = f, s[:i]
	}
	var total int64
	for _, part := range strings.Split(s, ":") {
		v, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			return -1
		}
		total = total*60 + v
	}
	return total*1000 + frac
}

// clock writes ms as SubRip/WebVTT ("01:02:03,456", sep "," or ".") or
// ASS ("1:02:03.45") time.
func clock(ms int64, sep string, ass bool) string {
	ms = max(ms, 0)
	h, rest := ms/3_600_000, ms%3_600_000
	m, rest := rest/60_000, rest%60_000
	s, frac := rest/1000, rest%1000
	if ass {
		return strconv.FormatInt(h, 10) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(frac/10, 2)
	}
	return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + sep + pad(frac, 3)
}

func pad(v int64, n int) string {
	s := strconv.FormatInt(v, 10)
	for len(s) < n {
		s = "0" + s
	}
	return s
}

// retime rewrites every line's times with shift(start) added to both, so
// each line keeps its length. A line pushed before 0 starts at 0.
func retime(data []byte, shift func(int64) int64) []byte {
	if isASS(data) {
		return assLine.ReplaceAllFunc(data, func(line []byte) []byte {
			m := assLine.FindSubmatch(line)
			a, b := clockMs(string(m[2])), clockMs(string(m[3]))
			d := shift(a)
			return []byte(string(m[1]) + clock(a+d, ".", true) + "," + clock(b+d, ".", true))
		})
	}
	return cueLine.ReplaceAllFunc(data, func(line []byte) []byte {
		m := cueLine.FindSubmatch(line)
		sep := ","
		if bytes.ContainsRune(m[1], '.') {
			sep = "."
		}
		a, b := clockMs(string(m[1])), clockMs(string(m[3]))
		d := shift(a)
		return []byte(clock(a+d, sep, false) + string(m[2]) + clock(b+d, sep, false))
	})
}
