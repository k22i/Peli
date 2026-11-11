// Spike for #3: embed libmpv, linked through cgo, into a Wails v3 window via
// the "wid" option and stream playback state to React as Wails events.
// Throwaway code; see README.md.
package main

import (
	"embed"
	"log"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// Modes (SPIKE_MODE):
//
//	single      one window: mpv embedded via wid, React overlay drawn by the
//	            same window's webview with a transparent background.
//	overlay     mpv embedded in the main window; the React overlay lives in a
//	            second frameless, transparent window that tracks the main one
//	            (needed on X11, see docs/spikes/mpv-wid-ipc.md).
//	composition Windows only: like single, but WebView2 uses DirectComposition
//	            visual hosting, whose visual tree sits above child HWNDs.
//
// On Windows, SPIKE_WIN_HOST picks what wid points at: "window" (the Wails
// top-level HWND, as in #2) or "container" (a child HWND we create at the
// bottom of the z-order, so mpv's window can never cover WebView2).
func spikeMode() string {
	if m := os.Getenv("SPIKE_MODE"); m != "" {
		return m
	}
	return "single"
}

func main() {
	mode := spikeMode()
	player := newPlayer(mode)

	app := application.New(application.Options{
		Name:        "peli-spike-libmpv-cgo",
		Description: "Spike: libmpv via cgo inside a Wails v3 window",
		Services:    []application.Service{application.NewService(player)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		OnShutdown:  player.shutdown,
	})
	player.app = app

	mainOpts := application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Peli spike: libmpv (" + mode + ")",
		Width:            1280,
		Height:           720,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		URL:              "/?role=" + map[bool]string{true: "host", false: "overlay"}[mode == "overlay"],
		Windows:          application.WindowsWindow{WebView2CompositionHosting: mode == "composition"},
	}
	if w := os.Getenv("SPIKE_WINDOW_W"); w != "" {
		mainOpts.Width, mainOpts.Height = atoi(w), atoi(os.Getenv("SPIKE_WINDOW_H"))
	}
	if x := os.Getenv("SPIKE_WINDOW_X"); x != "" {
		mainOpts.InitialPosition = application.WindowXY
		mainOpts.X, mainOpts.Y = atoi(x), atoi(os.Getenv("SPIKE_WINDOW_Y"))
	}
	mainWin := app.Window.NewWithOptions(mainOpts)
	player.window = mainWin
	mainWin.OnWindowEvent(events.Common.WindowDidResize, func(*application.WindowEvent) { player.onResize() })

	if mode == "overlay" {
		ov := app.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:             "overlay",
			Title:            "Peli spike overlay",
			Width:            mainOpts.Width,
			Height:           mainOpts.Height,
			Frameless:        true,
			BackgroundType:   application.BackgroundTypeTransparent,
			BackgroundColour: application.NewRGBA(0, 0, 0, 0),
			URL:              "/?role=overlay",
			Windows:          application.WindowsWindow{HiddenOnTaskbar: true},
		})
		player.overlay = ov
		mainWin.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) { player.syncOverlay() })
	}

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			if err := player.start(); err != nil {
				log.Printf("[spike] start failed: %v", err)
				player.record("launch", false, err.Error(), 0)
				player.finishSelftest()
			}
		}()
	})

	log.Printf("[spike] GOOS=%s mode=%s", runtime.GOOS, mode)
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}
