package main

import (
	"cmp"
	"context"
	"embed"
	"log"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Sinag/internal/account"
	"github.com/k22i/Sinag/internal/appinfo"
	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/firstmouse"
	"github.com/k22i/Sinag/internal/licences"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/syncer"
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

	db := store.NewService(store.DefaultPath())
	keychain := secrets.New(secrets.ServiceName)
	// $SINAG_NUVIO_URL points Sinag at a self-hosted Nuvio backend, such as
	// the contract tests' (#33).
	client := nuvio.New(cmp.Or(os.Getenv("SINAG_NUVIO_URL"), nuvio.DefaultURL), appinfo.Version)
	accounts := account.NewService(client, keychain, db)
	sync := syncer.NewService(db, backend.Nuvio{Client: client, Sessions: account.SessionOf(accounts)})
	// Sending what is queued is the first step of signing out (#30).
	account.FlushOnSignOut(accounts, syncer.PusherOf(sync))

	app := application.New(application.Options{
		Name:        "Sinag",
		Description: "A desktop client for Stremio-compatible addons, with Nuvio sync",
		Services: []application.Service{
			application.NewService(&appinfo.Service{}),
			application.NewService(&licences.Service{}),
			application.NewService(db),
			application.NewService(secrets.NewService(keychain)),
			application.NewServiceWithOptions(accounts,
				application.ServiceOptions{MarshalError: account.MarshalError}),
			application.NewService(sync),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Sinag",
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

	// Pull from Nuvio once the window is up, so the cached UI never waits for
	// it, and again each time the window gets focus (#29).
	puller, pusher := syncer.PullerOf(sync), syncer.PusherOf(sync)
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
		puller.Background(context.Background())
	})
	// Focus also retries pushes that failed, such as after being offline (#30).
	window.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) {
		puller.Background(context.Background())
		pusher.Background(context.Background())
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
