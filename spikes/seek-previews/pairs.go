package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
)

// pairs answers "how far apart are two releases of the same title?" with no
// network: the subtitle spike saved every release's embedded subtitle packet
// times (from Matroska Cues), and its aligner maps one timeline onto the
// other. For each smaller release of a title it reports the duration gap and
// what the timelines say: the same, a constant offset, a frame-rate ratio,
// or a cut (offsets that change along the film).

type refTrack struct {
	Codec    string  `json:"codec"`
	Language string  `json:"language"`
	Forced   bool    `json:"forced"`
	Count    int     `json:"cue_count"`
	Times    []int64 `json:"times"`
}

type refFile struct {
	Key        string     `json:"key"`
	DurationMs int64      `json:"duration_ms"`
	Tracks     []refTrack `json:"tracks"`
}

type PairResult struct {
	Played    string  `json:"played"`
	Preview   string  `json:"preview"`
	PlayedGB  float64 `json:"played_gb"`
	PreviewGB float64 `json:"preview_gb"`
	DurGapS   float64 `json:"duration_gap_s"` // preview − played
	Language  string  `json:"language,omitempty"`
	Scale     float64 `json:"scale,omitempty"`
	OffsetS   float64 `json:"offset_s,omitempty"` // played time = scale·preview time + offset
	Score     float64 `json:"score,omitempty"`
	Margin    float64 `json:"margin,omitempty"`
	MaxLocalS float64 `json:"max_local_s,omitempty"` // largest confident window deviation
	Verdict   string  `json:"verdict"`
}

func runPairs() {
	corpusB, err := os.ReadFile("../subtitle-autosync/results/corpus.json")
	check(err)
	var corpus []struct {
		Key  string `json:"key"`
		Slug string `json:"slug"`
		Size int64  `json:"size"`
	}
	check(json.Unmarshal(corpusB, &corpus))
	type rel struct {
		key string
		gb  float64
		ref refFile
	}
	by := map[string][]rel{}
	for _, e := range corpus {
		b, err := os.ReadFile(filepath.Join("../subtitle-autosync/results/refs", e.Key+".json"))
		if err != nil {
			continue
		}
		var r refFile
		if json.Unmarshal(b, &r) != nil || r.DurationMs == 0 {
			continue
		}
		by[e.Slug] = append(by[e.Slug], rel{e.Key, float64(e.Size) / 1e9, r})
	}
	var out []PairResult
	slugs := make([]string, 0, len(by))
	for s := range by {
		slugs = append(slugs, s)
	}
	sort.Strings(slugs)
	for _, s := range slugs {
		v := by[s]
		sort.Slice(v, func(i, j int) bool { return v[i].gb < v[j].gb })
		for i, played := range v {
			for _, prev := range v[:i] {
				out = append(out, comparePair(played.key, prev.key, played.gb, prev.gb, played.ref, prev.ref))
			}
		}
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	check(os.WriteFile("results/release-pairs.json", b, 0o644))
	counts := map[string]int{}
	for _, p := range out {
		counts[p.Verdict]++
		fmt.Printf("%-26s ← %-26s gap %+8.1f s  %-10s scale %.5f offset %+7.1f s local %5.1f s score %.2f\n",
			p.Played, p.Preview, p.DurGapS, p.Verdict, p.Scale, p.OffsetS, p.MaxLocalS, p.Score)
	}
	fmt.Println(counts)
}

// bestTrack picks the language both releases share with the most cues in
// each: a full track, not forced signs.
func bestTracks(a, b refFile) (refTrack, refTrack, bool) {
	pick := func(r refFile, lang string) (refTrack, bool) {
		var best refTrack
		for _, t := range r.Tracks {
			if norm(t.Language) == lang && !t.Forced && t.Count > best.Count {
				best = t
			}
		}
		return best, best.Count >= 200
	}
	for _, lang := range []string{"en", "es", "fr", "it", "de", "pt", "uk", "ru", "ja"} {
		ta, oka := pick(a, lang)
		tb, okb := pick(b, lang)
		if oka && okb {
			return ta, tb, true
		}
	}
	return refTrack{}, refTrack{}, false
}

func comparePair(playedKey, prevKey string, pgb, vgb float64, played, prev refFile) PairResult {
	p := PairResult{Played: playedKey, Preview: prevKey, PlayedGB: round1(pgb), PreviewGB: round1(vgb),
		DurGapS: float64(prev.DurationMs-played.DurationMs) / 1000}
	ta, tb, ok := bestTracks(played, prev)
	if !ok {
		p.Verdict = "no-ref"
		return p
	}
	p.Language = ta.Language
	al := Align(ta.Times, tb.Times)
	p.Scale, p.OffsetS, p.Score, p.Margin = al.Scale, al.OffsetMs/1000, round2(al.Score), round2(al.Margin)
	for _, w := range al.Windows {
		if w.Score >= 0.5 && math.Abs(float64(w.OffsetMs)) > p.MaxLocalS*1000 {
			p.MaxLocalS = math.Abs(float64(w.OffsetMs)) / 1000
		}
	}
	switch {
	case al.Score < 0.4 || al.Margin < 0.05:
		p.Verdict = "unsure"
	case al.Split || p.MaxLocalS >= 2:
		p.Verdict = "cut"
	case math.Abs(al.Scale-1) > 1e-4:
		p.Verdict = "fps"
	case math.Abs(p.OffsetS) < 1:
		p.Verdict = "same"
	default:
		p.Verdict = "offset"
	}
	return p
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }
func round2(f float64) float64 { return math.Round(f*100) / 100 }

// norm folds ISO 639-2 codes to 639-1 for the languages in the corpus.
func norm(l string) string {
	switch l {
	case "eng":
		return "en"
	case "spa":
		return "es"
	case "fre", "fra":
		return "fr"
	case "ita":
		return "it"
	case "ger", "deu":
		return "de"
	case "por":
		return "pt"
	case "ukr":
		return "uk"
	case "rus":
		return "ru"
	case "jpn":
		return "ja"
	}
	return l
}
