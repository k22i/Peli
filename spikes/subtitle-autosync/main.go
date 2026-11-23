// Spike: subtitle AutoSync for Peli (Nuvio-style, text-free alignment of
// addon subtitles to the embedded subtitles' packet times from Matroska
// Cues). Throwaway; findings in docs/spikes/subtitle-autosync.md.
//
//	go run . corpus -list mylist.json   # pick releases → results/corpus.json
//	go run . index                      # Cues + truth text (TorBox links)
//	go run . subs                       # OpenSubtitles v3 candidates
//	go run . eval                       # align every pair → results/pairs.json
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func itoa(n int) string { return strconv.Itoa(n) }

var cacheDir string

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: corpus|index|subs|eval")
		os.Exit(2)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	list := fs.String("list", "", "TorBox file list (corpus)")
	only := fs.String("only", "", "comma-separated entry keys")
	fs.StringVar(&cacheDir, "cache", os.Getenv("SPIKE_CACHE"), "cache dir for subtitle files and truth text (not committed)")
	fs.Parse(os.Args[2:])
	if cacheDir == "" {
		fmt.Fprintln(os.Stderr, "set -cache or SPIKE_CACHE")
		os.Exit(2)
	}
	os.MkdirAll(cacheDir, 0o755)
	os.MkdirAll("results/refs", 0o755)
	var err error
	switch os.Args[1] {
	case "corpus":
		err = cmdCorpus(*list)
	case "index":
		err = cmdIndex(*only)
	case "subs":
		err = cmdSubs(*only)
	case "eval":
		err = cmdEval()
	default:
		err = errors.New("unknown command")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func cmdCorpus(list string) error {
	var files []ListFile
	if err := readJSON(list, &files); err != nil {
		return err
	}
	c := selectCorpus(files)
	for _, e := range c {
		fmt.Printf("%-24s %6.1f GB  %s\n", e.Key, float64(e.Size)/1e9, e.Name)
	}
	return writeJSON("results/corpus.json", c)
}

func loadCorpus(only string) ([]Entry, error) {
	var c []Entry
	if err := readJSON("results/corpus.json", &c); err != nil {
		return nil, err
	}
	if only == "" {
		return c, nil
	}
	keep := map[string]bool{}
	for _, k := range strings.Split(only, ",") {
		keep[k] = true
	}
	var out []Entry
	for _, e := range c {
		if keep[e.Key] || keep[e.Slug] {
			out = append(out, e)
		}
	}
	return out, nil
}

// torboxLink asks TorBox for a download link to a file already in the
// account. The link carries a token: it stays in memory.
func torboxLink(ctx context.Context, e Entry) (string, error) {
	key := os.Getenv("TORBOX_API_KEY")
	if key == "" {
		return "", errors.New("TORBOX_API_KEY not set")
	}
	q := url.Values{"token": {key}, "torrent_id": {strconv.FormatInt(e.Torrent, 10)},
		"file_id": {strconv.FormatInt(e.File, 10)}, "redirect": {"false"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.torbox.app/v1/api/torrents/requestdl?"+q.Encode(), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", errors.New("torbox unreachable")
	}
	defer resp.Body.Close()
	var body struct {
		Success bool   `json:"success"`
		Data    string `json:"data"`
		Detail  string `json:"detail"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	if !body.Success || body.Data == "" {
		return "", fmt.Errorf("torbox: %s", body.Detail)
	}
	return body.Data, nil
}

// RefFile is what index saves per release: subtitle tracks with packet
// times (no text). Committed under results/refs/.
type RefFile struct {
	Key        string      `json:"key"`
	Container  string      `json:"container"`
	DurationMs int64       `json:"duration_ms"`
	CuesVia    string      `json:"cues_via,omitempty"`
	Requests   int         `json:"requests"`
	Bytes      int64       `json:"bytes"`
	ElapsedMs  int64       `json:"elapsed_ms"`
	Tracks     []RefTrack  `json:"tracks"`
	MP4Subs    []string    `json:"mp4_subs,omitempty"`
	TruthTrack uint64      `json:"truth_track,omitempty"`
	TruthReqs  int         `json:"truth_requests,omitempty"`
	TruthMs    int64       `json:"truth_ms,omitempty"`
	Error      string      `json:"error,omitempty"`
}

type RefTrack struct {
	SubTrack
	Times []int64 `json:"times"`
	Durs  []int64 `json:"durs,omitempty"`
}

// TruthCue is one embedded line read as text (cache only).
type TruthCue struct {
	Ms    int64  `json:"ms"`
	DurMs int64  `json:"dur_ms"`
	Text  string `json:"text"`
}

func cmdIndex(only string) error {
	c, err := loadCorpus(only)
	if err != nil {
		return err
	}
	for _, e := range c {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		ref := indexOne(ctx, e)
		cancel()
		if err := writeJSON(filepath.Join("results/refs", e.Key+".json"), ref); err != nil {
			return err
		}
		summary := ref.Error
		for _, t := range ref.Tracks {
			summary += fmt.Sprintf(" [%s %s%s %d]", t.Language, strings.TrimPrefix(t.Codec, "S_"), flags(t.SubTrack), t.CueCount)
		}
		if ref.Container == "mp4" {
			summary += " mp4 subs: " + strings.Join(ref.MP4Subs, ",")
		}
		fmt.Printf("%-24s %3d req %6.1f KB %5d ms %s |%s\n", e.Key, ref.Requests, float64(ref.Bytes)/1024, ref.ElapsedMs, ref.CuesVia, summary)
	}
	return nil
}

func flags(t SubTrack) string {
	s := ""
	if t.Forced {
		s += " forced"
	}
	if t.HI {
		s += " hi"
	}
	if t.Name != "" && len(t.Name) < 24 {
		s += " “" + t.Name + "”"
	}
	return s
}

func indexOne(ctx context.Context, e Entry) RefFile {
	ref := RefFile{Key: e.Key}
	link, err := torboxLink(ctx, e)
	if err != nil {
		ref.Error = err.Error()
		return ref
	}
	if strings.HasSuffix(strings.ToLower(e.Name), ".mp4") {
		ref.Container = "mp4"
		ref.MP4Subs = probeMP4(ctx, link)
		return ref
	}
	ref.Container = "mkv"
	r := newRanged(link)
	idx, err := LoadMKVIndex(ctx, r)
	if err != nil {
		ref.Error = err.Error()
		ref.Requests, ref.Bytes = r.Requests, r.Bytes
		return ref
	}
	ref.DurationMs, ref.CuesVia = idx.DurationMs, idx.CuesVia
	ref.Requests, ref.Bytes, ref.ElapsedMs = idx.Requests, idx.Bytes, idx.Elapsed.Milliseconds()
	for _, t := range idx.Tracks {
		rt := RefTrack{SubTrack: *t}
		for _, c := range t.Cues {
			rt.Times = append(rt.Times, c.Ms)
			if t.WithDuration > 0 {
				rt.Durs = append(rt.Durs, c.DurMs)
			}
		}
		ref.Tracks = append(ref.Tracks, rt)
	}
	// Ground truth: read the words of 3 × 12 lines of a full English text
	// track, at 15 %, 50 % and 85 % of it.
	var truth *SubTrack
	for _, t := range idx.Tracks {
		if t.Text() && !t.Forced && strings.HasPrefix(t.Language, "en") && len(t.Cues) >= 200 {
			if truth == nil || (truth.HI && !t.HI) {
				truth = t
			}
		}
	}
	if truth != nil {
		start := time.Now()
		reqs := r.Requests
		var lines []TruthCue
		for _, at := range []float64{0.15, 0.5, 0.85} {
			i0 := int(at * float64(len(truth.Cues)))
			for i := i0; i < i0+12 && i < len(truth.Cues); i++ {
				text, dur, err := ReadCueText(ctx, r, idx, truth, truth.Cues[i])
				if err != nil {
					continue
				}
				lines = append(lines, TruthCue{Ms: truth.Cues[i].Ms, DurMs: dur, Text: clean(text)})
			}
		}
		ref.TruthTrack = truth.Number
		ref.TruthReqs = r.Requests - reqs
		ref.TruthMs = time.Since(start).Milliseconds()
		writeJSON(filepath.Join(cacheDir, "truth-"+e.Key+".json"), lines)
	}
	return ref
}

// probeMP4 lists an MP4's subtitle streams with ffprobe (it reads moov).
func probeMP4(ctx context.Context, link string) []string {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "s",
		"-show_entries", "stream=codec_name:stream_tags=language", "-of", "csv=p=0", link).Output()
	if err != nil {
		return []string{"ffprobe failed"}
	}
	var subs []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			subs = append(subs, l)
		}
	}
	if len(subs) == 0 {
		return []string{"none"}
	}
	return subs
}

// --- OpenSubtitles v3 (the addon Peli users install) ---

type OSSub struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Lang        string `json:"lang"`
	FileName    string `json:"subtitleFileName"`
	ReleaseName string `json:"movieReleaseName"`
	FPS         int    `json:"fpsMilli"`
}

// SubList is the candidates for one release (committed, no files).
type SubList struct {
	Key  string  `json:"key"`
	Subs []OSSub `json:"subs"`
}

const (
	perLangMax = 6
	ua         = "Peli-spike/0.1"
)

var wantLangs = []string{"eng", "spa", "fre"}

func cmdSubs(only string) error {
	c, err := loadCorpus(only)
	if err != nil {
		return err
	}
	for _, e := range c {
		// Like Peli: the stream's file name and size as extras.
		extra := "filename=" + url.PathEscape(e.Name) + "&videoSize=" + strconv.FormatInt(e.Size, 10)
		u := "https://opensubtitles-v3.strem.io/subtitles/" + e.Type + "/" + e.StremioID() + "/" + extra + ".json"
		var resp struct {
			Subtitles []OSSub `json:"subtitles"`
		}
		if err := getJSON(u, &resp); err != nil {
			fmt.Printf("%-24s %v\n", e.Key, err)
			continue
		}
		list := SubList{Key: e.Key}
		count := map[string]int{}
		for _, s := range resp.Subtitles {
			if !contains(wantLangs, s.Lang) || count[s.Lang] >= perLangMax {
				continue
			}
			path := filepath.Join(cacheDir, "sub-"+s.ID)
			if _, err := os.Stat(path); err != nil {
				data, err := getBytes(s.URL)
				if err != nil {
					continue
				}
				os.WriteFile(path, data, 0o644)
				time.Sleep(150 * time.Millisecond)
			}
			count[s.Lang]++
			s.URL = "" // the list keeps ids, not links
			list.Subs = append(list.Subs, s)
		}
		writeJSON(filepath.Join("results/refs", e.Key+".subs.json"), list)
		fmt.Printf("%-24s %d of %d subtitles (%v)\n", e.Key, len(list.Subs), len(resp.Subtitles), count)
	}
	return nil
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if x == y {
			return true
		}
	}
	return false
}

func getBytes(u string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", ua)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 16<<20))
}

func getJSON(u string, v any) error {
	b, err := getBytes(u)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
