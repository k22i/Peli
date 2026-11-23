package subsync

import (
	"math"
	"sort"
	"strings"
)

// Status is what syncing a subtitle file found.
type Status string

const (
	// Synced: the file was off and was retimed.
	Synced Status = "synced"
	// InSync: the file fits the video as it is.
	InSync Status = "inSync"
	// NoMatch: no confident fit; the file is left as it was.
	NoMatch Status = "noMatch"
	// NoReference: the video has nothing to compare with.
	NoReference Status = "noReference"
	// Unchecked: the file couldn't be read as subtitles, or the reference
	// wasn't there in time.
	Unchecked Status = "unchecked"
)

// Result is what Sync did.
type Result struct {
	Status Status
	// ShiftMs is how far the first and last lines moved (later is
	// positive). They differ when the frame rate was corrected.
	FirstShiftMs, LastShiftMs int64
}

// minLines: a file with fewer lines isn't worth aligning (a signs file).
const minLines = 50

// Sync lines up the subtitle file data (SubRip, WebVTT or ASS) with ref,
// the video's own subtitle timing. language is the file's ISO 639 code
// ("en", "por"), or "": a reference in the same language goes first. It
// returns the retimed file when it moved, or data as it was.
func Sync(ref *Reference, data []byte, language string) ([]byte, Result) {
	if ref == nil || len(ref.Tracks) == 0 {
		return data, Result{Status: NoReference}
	}
	starts, ends := lineTimes(data)
	if len(starts) < minLines {
		return data, Result{Status: Unchecked}
	}
	refs := references(ref, language, len(starts))
	if len(refs) == 0 {
		return data, Result{Status: NoReference}
	}
	var best alignment
	found := false
	for _, t := range refs {
		pts := starts
		if t.Picture {
			pts = picturePoints(starts, ends)
		}
		a, ok := align(t.Times, pts)
		if ok && (!found || a.score+a.margin > best.score+best.margin) {
			best, found = a, true
		}
	}
	if !found || best.score < minScore || best.margin < minMargin {
		return data, Result{Status: NoMatch}
	}
	first, last := starts[0], starts[len(starts)-1]
	res := Result{
		Status:       Synced,
		FirstShiftMs: int64(math.Round(best.shiftAt(first))),
		LastShiftMs:  int64(math.Round(best.shiftAt(last))),
	}
	if math.Abs(best.shiftAt(first)) <= toleranceMs && math.Abs(best.shiftAt(last)) <= toleranceMs {
		return data, Result{Status: InSync}
	}
	out := retime(data, func(t int64) int64 { return int64(math.Round(best.shiftAt(t))) })
	return out, res
}

// picturePoints: a picture reference has a packet where each line starts
// and another where it clears, so the candidate gives both.
func picturePoints(starts, ends []int64) []int64 {
	pts := make([]int64, 0, 2*len(starts))
	pts = append(append(pts, starts...), ends...)
	sort.Slice(pts, func(i, j int) bool { return pts[i] < pts[j] })
	return pts
}

// references picks up to three of ref's tracks to try: full (not forced)
// tracks with enough packets for the candidate's lines, the candidate's
// language first, then text before pictures, then the longest; one per
// language and kind.
func references(ref *Reference, language string, lines int) []Track {
	floor := max(minLines, lines/4)
	var out []Track
	seen := map[string]bool{}
	for _, t := range ref.Tracks {
		need := floor
		if t.Picture {
			need = 2 * floor // two packets a line
		}
		key := baseLanguage(t.Language) + map[bool]string{true: "/picture"}[t.Picture]
		if t.Forced || len(t.Times) < need || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, t)
	}
	want := baseLanguage(language)
	rank := func(t Track) int {
		r := 0
		if want == "" || baseLanguage(t.Language) != want {
			r += 2
		}
		if t.Picture {
			r++
		}
		return r
	}
	sort.SliceStable(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return len(out[i].Times) > len(out[j].Times)
	})
	return out[:min(len(out), 3)]
}

// baseLanguage folds "en-US", "eng" and "en" into "en"; codes it doesn't
// know stay as they are (lower case).
func baseLanguage(tag string) string {
	tag = strings.ToLower(tag)
	if i := strings.IndexAny(tag, "-_"); i >= 0 {
		tag = tag[:i]
	}
	if two, ok := iso639[tag]; ok {
		return two
	}
	return tag
}

// The three-letter codes Matroska files and addons use for the languages
// subtitles come in most.
var iso639 = map[string]string{
	"eng": "en", "spa": "es", "fre": "fr", "fra": "fr", "ger": "de", "deu": "de",
	"ita": "it", "por": "pt", "pob": "pt", "rus": "ru", "jpn": "ja", "chi": "zh",
	"zho": "zh", "kor": "ko", "ara": "ar", "dut": "nl", "nld": "nl", "pol": "pl",
	"tur": "tr", "swe": "sv", "dan": "da", "nor": "no", "nob": "no", "fin": "fi",
	"cze": "cs", "ces": "cs", "hun": "hu", "rum": "ro", "ron": "ro", "gre": "el",
	"ell": "el", "heb": "he", "hin": "hi", "tha": "th", "vie": "vi", "ind": "id",
	"ukr": "uk", "bul": "bg", "hrv": "hr", "srp": "sr", "slv": "sl", "slo": "sk",
	"slk": "sk", "per": "fa", "fas": "fa", "msa": "ms", "may": "ms", "est": "et",
	"lav": "lv", "lit": "lt", "cat": "ca", "baq": "eu", "eus": "eu", "glg": "gl",
	"ice": "is", "isl": "is", "tam": "ta", "tel": "te", "fil": "tl",
}
