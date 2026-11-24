// Command seekpreviews measures what seek-bar thumbnails cost when Peli makes
// them itself: a second headless libmpv on the stream, one keyframe per N
// seconds. See docs/spikes/seek-previews.md.
//
//	go run . -file clip.mkv -every 10
//	go run . -torbox dune-2021-1 -every 10 -max 60     # needs TORBOX_API_KEY
//	go run . -url https://… -every 30
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type Record struct {
	At    float64 `json:"at"`
	Got   float64 `json:"got"`
	Ms    int64   `json:"ms"`
	Bytes int64   `json:"bytes"`
	Reqs  int64   `json:"requests"`
	Err   string  `json:"error,omitempty"`
}

type Run struct {
	Name      string    `json:"name"`
	Source    string    `json:"source"`
	Size      int64     `json:"size,omitempty"`
	Codec     string    `json:"codec"`
	Video     string    `json:"video"`
	Gamma     string    `json:"gamma"`
	Duration  float64   `json:"duration"`
	Hwdec     string    `json:"hwdec"`
	Width     int       `json:"width"`
	Every     float64   `json:"every"`
	Order     string    `json:"order"`
	Chunk     int64     `json:"chunk"`
	Queue     string    `json:"queue"`
	OpenMs    int64     `json:"open_ms"`
	OpenBytes int64     `json:"open_bytes"`
	TotalMs   int64     `json:"total_ms"`
	Bytes     int64     `json:"bytes"`
	MedianMs  int64     `json:"median_ms"`
	P90Ms     int64     `json:"p90_ms"`
	MedianKB  int64     `json:"median_kb"`
	SheetKB   int64     `json:"sheet_kb"`
	Thumbs    []Record  `json:"thumbs"`
	Date      time.Time `json:"date"`
}

func main() {
	file := flag.String("file", "", "local file (served over loopback HTTP so bytes are counted)")
	rawURL := flag.String("url", "", "a stream URL")
	torbox := flag.String("torbox", "", "a key from spikes/subtitle-autosync/results/corpus.json")
	every := flag.Float64("every", 10, "seconds between thumbnails")
	maxN := flag.Int("max", 0, "stop after this many thumbnails (0: all)")
	order := flag.String("order", "seq", "seq (start to end) or coarse (whole film first, then fill in)")
	width := flag.Int("width", 320, "thumbnail width")
	hwdec := flag.String("hwdec", "no", "mpv hwdec")
	name := flag.String("name", "", "run name (default from the source)")
	out := flag.String("out", "out", "where sprite sheets go")
	chunk := flag.Int64("chunk", 0, "HTTP request size in bytes (0: open-ended)")
	queue := flag.String("queue", "4MiB", "demuxer-max-bytes")
	tonemap := flag.Bool("tonemap", true, "tone map PQ/HLG frames in Go")
	flag.Parse()

	ctx := context.Background()
	c := &counter{ua: "Peli-spike/0.1", client: &http.Client{}}
	run := Run{Hwdec: *hwdec, Width: *width, Every: *every, Order: *order, Chunk: *chunk, Queue: *queue, Date: time.Now().UTC()}
	switch {
	case *file != "":
		fs, stop := serveFile(*file)
		defer stop()
		c.upstream = fs
		run.Name, run.Source = filepath.Base(*file), "local"
		if st, err := os.Stat(*file); err == nil {
			run.Size = st.Size()
		}
	case *torbox != "":
		e, err := corpusEntry(*torbox)
		check(err)
		link, err := torboxLink(ctx, e)
		check(err)
		c.upstream = link
		run.Name, run.Source, run.Size = e.Key, "torbox", e.Size
	case *rawURL != "":
		c.upstream = *rawURL
		u, _ := url.Parse(*rawURL)
		run.Name, run.Source = filepath.Base(u.Path), u.Host
	default:
		flag.Usage()
		os.Exit(2)
	}
	if *name != "" {
		run.Name = *name
	}
	local, stop := serve(c, "video")
	defer stop()

	t, openTook, err := openThumbnailer(local, Options{Width: *width, Hwdec: *hwdec, Chunk: *chunk, Queue: *queue})
	check(err)
	defer t.Close()
	run.OpenMs = openTook.Milliseconds()
	run.OpenBytes, _, _ = c.take()
	run.Codec, run.Gamma, run.Duration = t.Codec, t.Gamma, t.Duration
	run.Video = fmt.Sprintf("%dx%d %s", t.W, t.H, t.Prim)
	fmt.Fprintf(os.Stderr, "%s: %s %s %.0f s, open %d ms, %d KB\n", run.Name, run.Video, t.Gamma, t.Duration, run.OpenMs, run.OpenBytes>>10)

	times := schedule(t.Duration, *every, *order)
	if *maxN > 0 && len(times) > *maxN {
		times = times[:*maxN]
	}
	thumbs := map[float64]*image.RGBA{}
	start := time.Now()
	for i, at := range times {
		t0 := time.Now()
		img, got, err := t.At(at)
		r := Record{At: at, Got: got, Ms: time.Since(t0).Milliseconds()}
		r.Bytes, r.Reqs, _ = c.take()
		if err != nil {
			r.Err = err.Error()
		} else {
			if *tonemap && (t.Gamma == "pq" || t.Gamma == "hlg") {
				toneMap(img, t.Gamma, t.Prim)
			}
			thumbs[at] = img
		}
		run.Thumbs = append(run.Thumbs, r)
		if i%10 == 0 || i == len(times)-1 {
			fmt.Fprintf(os.Stderr, "  %d/%d at %.0f → %.1f, %d ms, %d KB, %d req %s\n", i+1, len(times), at, got, r.Ms, r.Bytes>>10, r.Reqs, r.Err)
		}
	}
	run.TotalMs = time.Since(start).Milliseconds()
	summarise(&run)

	check(os.MkdirAll(*out, 0o755))
	sheet := filepath.Join(*out, run.Name+".jpg")
	run.SheetKB = writeSheet(sheet, times, thumbs) >> 10
	b, _ := json.MarshalIndent(run, "", "  ")
	res := filepath.Join("results", fmt.Sprintf("%s-%s-%d-%dk-%s.json", run.Name, *hwdec, int(*every), *chunk>>10, *queue))
	check(os.WriteFile(res, b, 0o644))
	fmt.Printf("%s\t%s\topen %d ms\t%d thumbs in %.1f s\tmedian %d ms p90 %d ms\tmedian %d KB\ttotal %d MB\tsheet %d KB\n",
		run.Name, run.Video, run.OpenMs, len(run.Thumbs), float64(run.TotalMs)/1000, run.MedianMs, run.P90Ms, run.MedianKB, run.Bytes>>20, run.SheetKB)
}

// schedule lists the thumbnail times. "coarse" orders them so that any
// prefix covers the whole film evenly: every 2^k-th first, then halves.
func schedule(duration, every float64, order string) []float64 {
	var times []float64
	for at := 0.0; at < duration; at += every {
		times = append(times, at)
	}
	if order != "coarse" {
		return times
	}
	n := len(times)
	step := 1
	for step*2 < n {
		step *= 2
	}
	seen := make([]bool, n)
	var out []float64
	for ; step >= 1; step /= 2 {
		for i := 0; i < n; i += step {
			if !seen[i] {
				seen[i] = true
				out = append(out, times[i])
			}
		}
	}
	return out
}

func summarise(run *Run) {
	var ms, kb []int64
	for _, r := range run.Thumbs {
		run.Bytes += r.Bytes
		if r.Err == "" {
			ms = append(ms, r.Ms)
			kb = append(kb, r.Bytes>>10)
		}
	}
	run.Bytes += run.OpenBytes
	pct := func(v []int64, p float64) int64 {
		if len(v) == 0 {
			return 0
		}
		sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
		return v[int(float64(len(v)-1)*p)]
	}
	run.MedianMs, run.P90Ms, run.MedianKB = pct(ms, 0.5), pct(ms, 0.9), pct(kb, 0.5)
}

// writeSheet tiles the thumbnails in time order, 10 across, as one JPEG:
// the shape Jellyfin's trickplay and Plex's BIF files store.
func writeSheet(path string, times []float64, thumbs map[float64]*image.RGBA) int64 {
	sorted := append([]float64(nil), times...)
	sort.Float64s(sorted)
	var tw, th int
	for _, img := range thumbs {
		tw, th = img.Bounds().Dx(), img.Bounds().Dy()
		break
	}
	if tw == 0 {
		return 0
	}
	cols := 10
	rows := (len(sorted) + cols - 1) / cols
	sheet := image.NewRGBA(image.Rect(0, 0, cols*tw, rows*th))
	for i, at := range sorted {
		if img := thumbs[at]; img != nil {
			p := image.Pt((i%cols)*tw, (i/cols)*th)
			draw.Draw(sheet, image.Rectangle{p, p.Add(image.Pt(tw, th))}, img, image.Point{}, draw.Src)
		}
	}
	f, err := os.Create(path)
	check(err)
	defer f.Close()
	check(jpeg.Encode(f, sheet, &jpeg.Options{Quality: 70}))
	st, _ := f.Stat()
	return st.Size()
}

func serveFile(path string) (string, func()) {
	mux := http.NewServeMux()
	mux.HandleFunc("/f", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, path) })
	srv := &http.Server{Handler: mux}
	ln := listen()
	go srv.Serve(ln)
	return "http://" + ln.Addr().String() + "/f", func() { srv.Close() }
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
