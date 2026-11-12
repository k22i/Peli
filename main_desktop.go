//go:build !ios

package main

import (
	"context"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"

	"github.com/k22i/Peli/internal/account"
	"github.com/k22i/Peli/internal/appinfo"
	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/firstmouse"
	"github.com/k22i/Peli/internal/party"
	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/plugins"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/syncer"
	"github.com/k22i/Peli/internal/torrent"
	"github.com/k22i/Peli/internal/updates"
)

// main is the desktop app (macOS, Windows, Linux). main_ios.go is the iOS one
// (ADR-0055): it leaves out everything below that the App Store build must
// not contain, which is why those services are wired here and not in main.go.
func main() {
	// Started as a plugin sandbox (#56): run that one call and exit, before
	// anything of the app starts.
	plugins.ServeChild()
	// Started by an update (#83) to put the new Peli.app in place once this
	// one has quit, and open it. application.New does this too, but only
	// after everything above it in main has run.
	updater.HandleHelperMode()

	firstmouse.Enable()

	// An install from when the app was Sinag moves to Peli's folders first.
	if err := store.MoveFromSinag(); err != nil {
		log.Printf("moving Sinag's folders to Peli's: %v", err)
	}
	p := newPeli(store.DefaultPath())
	players := p.players
	// Hardware decoding, as Settings › Playback has it (#66).
	player.UseSettings(players, p.db)
	// Plugins are off for every profile until its owner turns them on, and
	// never run for a kids profile (#57); their list is the profile's, kept
	// in the store and synced with Nuvio.
	pluginHost := plugins.NewService(appinfo.Version)
	plugins.UseStore(pluginHost, func() *store.Store { return store.Opened(p.db) }, account.EditorOf(p.accounts))
	// Watch parties with Nuvio's apps (ADR-0051): the party keeps the
	// player in step, and the user's pauses and seeks go through it first.
	parties := party.NewService(backend.Parties{Client: p.client, Sessions: account.SessionOf(p.accounts)},
		party.Who(p.db, account.SessionOf(p.accounts).SignedIn))
	party.UsePlayer(parties, player.DirectOf(players))
	player.GateWith(players, party.GateOf(parties))
	// Updates (#83, ADR-0054): checked and downloaded in the background,
	// installed when the user restarts, never while something plays.
	appUpdates := updates.NewService(appinfo.Version)
	updates.UseSettings(appUpdates, p.db)
	updates.UsePlayer(appUpdates, func() bool { return player.Playing(players) })

	app := application.New(application.Options{
		Name:        "Peli",
		Description: description,
		Services: p.services(extras{
			updates: application.NewServiceWithOptions(appUpdates,
				application.ServiceOptions{MarshalError: updates.MarshalError}),
			// Nuvio JS plugins, each call in its own sandbox process (#56),
			// and which ones a profile runs (#57).
			plugins: application.NewServiceWithOptions(pluginHost,
				application.ServiceOptions{MarshalError: plugins.MarshalError}),
			// Torrents streamed peer to peer, if the user turns it on (#55).
			torrent: application.NewServiceWithOptions(torrent.NewService(p.db, torrent.DefaultDir(), appinfo.Version),
				application.ServiceOptions{MarshalError: torrent.MarshalError}),
			parties: application.NewServiceWithOptions(parties,
				application.ServiceOptions{MarshalError: party.MarshalError}),
		}),
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Peli",
		// Opens at 1600×900 (16:9), midway between 1280×720 and 1920×1080.
		Width:  1600,
		Height: 900,
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

	player.UseWindow(players, window)
	player.UseMediaControls(players)

	// Pull from Nuvio once the window is up, so the cached UI never waits for
	// it, and again each time the window gets focus (#29).
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
		syncer.PullerOf(p.sync).Background(context.Background())
		p.importTracked()
	})
	// Focus also retries pushes that failed, such as after being offline (#30).
	window.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) {
		p.pullAndPush()
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
