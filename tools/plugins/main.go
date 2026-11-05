// Command plugins runs Nuvio plugins in Sinag's sandbox (#56), the way the
// app does, and reports what each answered: how many streams, how long it
// took, or which error. Use it to check a plugin repository against the
// host API.
//
//	go run ./tools/plugins -manifest https://…/manifest.json -tmdb 550 -type movie
//	go run ./tools/plugins -file ./plugin.js -tmdb 1396 -type tv -s 1 -e 1
//
// Stream URLs are shown by host only; -v prints the plugins' console
// output.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Sinag/internal/plugins"
)

func main() {
	plugins.ServeChild()

	manifest := flag.String("manifest", "", "a plugin repository's manifest.json URL")
	file := flag.String("file", "", "one plugin's code, from a file")
	only := flag.String("only", "", "with -manifest: comma-separated plugin ids to run")
	tmdb := flag.String("tmdb", "550", "TMDB id")
	media := flag.String("type", "movie", "movie or tv")
	season := flag.Int("s", 1, "season, for tv")
	episode := flag.Int("e", 1, "episode, for tv")
	verbose := flag.Bool("v", false, "print the plugins' console output")
	flag.Parse()
	if *verbose {
		os.Setenv("SINAG_PLUGIN_LOG", "1")
	}
	query := plugins.Query{TmdbID: *tmdb, MediaType: *media, Season: *season, Episode: *episode}
	ctx := context.Background()

	runner := plugins.NewRunner()
	var jobs []plugins.Job
	switch {
	case *file != "":
		code, err := os.ReadFile(*file)
		if err != nil {
			log.Fatal(err)
		}
		jobs = append(jobs, job(*file, string(code), query))
	case *manifest != "":
		svc := plugins.NewService("dev")
		list, err := plugins.ManifestPlugins(ctx, svc, *manifest)
		if err != nil {
			log.Fatal(err)
		}
		want := map[string]bool{}
		for id := range strings.SplitSeq(*only, ",") {
			if id != "" {
				want[id] = true
			}
		}
		var wg sync.WaitGroup
		for _, p := range list {
			if len(want) > 0 && !want[p.ID] {
				continue
			}
			wg.Go(func() {
				start := time.Now()
				streams, err := plugins.RunUnchecked(ctx, svc, p, query)
				report(p.ID, start, streams, err)
			})
		}
		wg.Wait()
		return
	default:
		flag.Usage()
		os.Exit(2)
	}
	for _, j := range jobs {
		start := time.Now()
		streams, err := runner.Run(ctx, j)
		report(j.ID, start, streams, err)
	}
}

func job(id, code string, query plugins.Query) plugins.Job {
	return plugins.Job{ID: id, Code: code, Query: query, Limits: plugins.DefaultLimits, UserAgent: "Sinag/dev"}
}

var mu sync.Mutex

func report(id string, start time.Time, streams []plugins.Stream, err error) {
	mu.Lock()
	defer mu.Unlock()
	took := time.Since(start).Round(10 * time.Millisecond)
	if err != nil {
		fmt.Printf("%-28s %7s  error: %v\n", id, took, err)
		return
	}
	fmt.Printf("%-28s %7s  %d streams\n", id, took, len(streams))
	for i, s := range streams {
		if i == 5 {
			fmt.Printf("    … %d more\n", len(streams)-5)
			break
		}
		host := "?"
		if u, err := url.Parse(s.URL); err == nil {
			host = u.Host
		}
		fmt.Printf("    %-10s %-8s %-40.40s %s\n", s.Quality, s.Size, strings.ReplaceAll(s.Name+" · "+s.Title, "\n", " "), host)
	}
}
