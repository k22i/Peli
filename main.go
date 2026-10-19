package main

import (
	"embed"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Cove/internal/appinfo"
	"github.com/k22i/Cove/internal/firstmouse"
	"github.com/k22i/Cove/internal/store"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

// The --sidebar token in each mode (frontend/src/index.css); keep in step
// with windowColours in frontend/src/lib/theme.ts.
var (
	windowColourLight = application.NewRGB(247, 247, 248)
	windowColourDark  = application.NewRGB(17, 17, 17)
)

func main() {
	firstmouse.Enable()

	app := application.New(application.Options{
		Name:        "Cove",
		Description: "A desktop client for Stremio-compatible addons, with Nuvio sync",
		Services: []application.Service{
			application.NewService(&appinfo.Service{}),
			application.NewService(store.NewService(store.DefaultPath())),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Cove",
		// Window sized to the golden ratio (1000 / 618 ≈ 1.618).
		Width:  1000,
		Height: 618,
		// The app shell draws the title bar where the OS allows (#12): macOS
		// keeps its traffic lights over the shell's 44px drag strip, Windows
		// is frameless with our own caption buttons, and Linux keeps its
		// native frame (GNOME, KDE and tiling WMs disagree on decorations).
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 44,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		Frameless: runtime.GOOS == "windows",
		// The shell's outer colour (--sidebar), so there is no flash on load.
		// Dark until the OS appearance is known below; the frontend then
		// follows the user's theme (frontend/src/lib/theme.ts).
		BackgroundColour: windowColourDark,
		URL:              "/",
	})

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
