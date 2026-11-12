// Spike: libmpv (our LGPL build, as a dynamic xcframework) under a Wails v3
// iOS webview. The same main.go layout as the desktop app: a Go service the
// page calls, events back to the page, one window.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed frontend/*
var assets embed.FS

func main() {
	player := &Player{}
	app := application.New(application.Options{
		Name:        "libmpv spike",
		Description: "libmpv under a Wails iOS webview",
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Services:    []application.Service{application.NewService(player)},
		IOS: application.IOSOptions{
			// Taps and drags on the controls only: no page scroll or bounce.
			DisableScroll: true, DisableBounce: true, DisableScrollIndicators: true,
			// Black until the video draws.
			BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		},
	})
	player.app = app
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "libmpv spike",
		URL:   "/",
		// Transparent: the page must not paint the video over.
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
	})
	player.win = win
	// The native handle exists once the window's runtime is up.
	win.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		go player.autostart()
	})
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
