// Spike for #4: draw libmpv's video through its render API into a native
// layer/widget *under* the Wails webview, on macOS and Linux (Wayland and
// X11), and keep the React overlay working on top. Throwaway code; see
// README.md.
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
//	gl          macOS: CAOpenGLLayer view below the WKWebView, render API (OpenGL).
//	glarea      Linux: GtkGLArea below the WebKitWebView in a GtkOverlay,
//	            render API (OpenGL) on the GTK thread. X11 and Wayland.
//	subsurface  Wayland: our own wl_subsurface placed below GTK's surface,
//	            EGL + render API on a dedicated render thread.
//	sw          macOS + Linux: render API "sw" on a render thread, frames
//	            shown as an image below the webview.
//	wid         Linux X11, the #3 baseline: mpv's own X window embedded with
//	            wid (covers the UI in a single window).
//	overlay     Linux X11, the #3 baseline as it would ship: wid plus a
//	            second transparent window for the React UI.
func spikeMode() string {
	if m := os.Getenv("SPIKE_MODE"); m != "" {
		return m
	}
	if runtime.GOOS == "darwin" {
		return "gl"
	}
	return "glarea"
}

func main() {
	mode := spikeMode()
	player := newPlayer(mode)

	app := application.New(application.Options{
		Name:        "sinag-spike-mpv-render-api",
		Description: "Spike: mpv render API under a Wails v3 webview",
		Services:    []application.Service{application.NewService(player)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		OnShutdown:  player.shutdown,
	})
	player.app = app

	mainOpts := application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Sinag spike: mpv render API (" + mode + ")",
		Width:            1280,
		Height:           720,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		URL:              "/?role=" + map[bool]string{true: "host", false: "overlay"}[mode == "overlay"],
		// The webview must be transparent so the video layer below shows through.
		Mac: application.MacWindow{Backdrop: application.MacBackdropTransparent},
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
			Title:            "Sinag spike overlay",
			Width:            mainOpts.Width,
			Height:           mainOpts.Height,
			Frameless:        true,
			BackgroundType:   application.BackgroundTypeTransparent,
			BackgroundColour: application.NewRGBA(0, 0, 0, 0),
			URL:              "/?role=overlay",
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
