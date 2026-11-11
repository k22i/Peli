// Spike for #7: an empty Wails v3 shell, optionally with libmpv linked and
// initialised, that reports when it first painted. The launcher in bench/
// measures memory and the packaging scripts measure installer size.
// Throwaway code; see README.md.
package main

import (
	"embed"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// goInit is taken during package initialisation, i.e. after the OS loader has
// mapped the binary and every dylib/DLL/.so it links (libmpv included) and the
// Go runtime has started, but before main runs.
var goInit = time.Now()

// Probe collects Go-side timestamps and writes the report once the page says
// it has painted. Env:
//
//	BASELINE_REPORT     path of the JSON report (written atomically)
//	BASELINE_QUIT_FILE  quit as soon as this file exists (polled every 100 ms)
//	BASELINE_PAGE       "shell" (default) or "home" (synthetic posters)
//	BASELINE_NO_MPV=1   skip mpv init in an mpv build (libmpv still loaded)
type Probe struct {
	mu    sync.Mutex
	marks map[string]int64 // name -> epoch µs
	mpv   map[string]any
	app   *application.App
}

func (p *Probe) mark(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.marks[name]; !ok {
		p.marks[name] = time.Now().UnixMicro()
	}
}

// Report is called by the page with its own marks (epoch ms, fractional).
func (p *Probe) Report(page map[string]any) {
	p.mark("reportReceived")
	path := os.Getenv("BASELINE_REPORT")
	p.mu.Lock()
	out := map[string]any{
		"pid":     os.Getpid(),
		"goos":    runtime.GOOS,
		"goarch":  runtime.GOARCH,
		"mpvLink": mpvLinked,
		"go":      p.marks,
		"mpv":     p.mpv,
		"page":    page,
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	p.mu.Unlock()
	if path == "" {
		log.Printf("[baseline] report: %s", b)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Printf("[baseline] write report: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		log.Printf("[baseline] rename report: %v", err)
	}
}

// Late lets the page add marks that come after the report (e.g. posters
// decoded on the Home page); the launcher re-reads the file at the end.
func (p *Probe) Late(page map[string]any) {
	path := os.Getenv("BASELINE_REPORT")
	if path == "" {
		log.Printf("[baseline] late: %v", page)
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var out map[string]any
	if json.Unmarshal(b, &out) != nil {
		return
	}
	out["late"] = page
	b, _ = json.MarshalIndent(out, "", "  ")
	_ = os.WriteFile(path+".tmp", b, 0o644)
	_ = os.Rename(path+".tmp", path)
}

func (p *Probe) Page() string {
	if v := os.Getenv("BASELINE_PAGE"); v != "" {
		return v
	}
	return "shell"
}

func main() {
	probe := &Probe{marks: map[string]int64{"goInit": goInit.UnixMicro()}}
	probe.mark("main")

	app := application.New(application.Options{
		Name:        "Peli baseline",
		Description: "Spike #7: baseline measurements",
		Services:    []application.Service{application.NewService(probe)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
	})
	probe.app = app

	// The real app's window is transparent so video can sit under the webview
	// (#3, #4); the page paints its own opaque background.
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Peli baseline",
		Width:            1280,
		Height:           800,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		URL:              "/",
	})
	win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) { probe.mark("windowShow") })
	win.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { probe.mark("runtimeReady") })

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		probe.mark("appStarted")
		if mpvLinked && os.Getenv("BASELINE_NO_MPV") == "" {
			// Off the UI thread, as the real player service would.
			go func() {
				info := initMPV()
				probe.mu.Lock()
				probe.mpv = info
				probe.mu.Unlock()
				probe.mark("mpvReady")
			}()
		}
	})

	if q := os.Getenv("BASELINE_QUIT_FILE"); q != "" {
		go func() {
			for {
				time.Sleep(100 * time.Millisecond)
				if _, err := os.Stat(q); err == nil {
					app.Quit()
					return
				}
			}
		}()
	}

	log.Printf("[baseline] GOOS=%s mpv=%v exe=%s", runtime.GOOS, mpvLinked, filepath.Base(os.Args[0]))
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
