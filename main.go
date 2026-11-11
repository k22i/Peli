package main

import (
	"cmp"
	"context"
	"embed"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Sinag/internal/account"
	"github.com/k22i/Sinag/internal/addons"
	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/anilistaddon"
	"github.com/k22i/Sinag/internal/animelist"
	"github.com/k22i/Sinag/internal/appinfo"
	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/firstmouse"
	"github.com/k22i/Sinag/internal/licences"
	"github.com/k22i/Sinag/internal/markers"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/party"
	"github.com/k22i/Sinag/internal/player"
	"github.com/k22i/Sinag/internal/plugins"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/simkl"
	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/streams"
	"github.com/k22i/Sinag/internal/syncer"
	"github.com/k22i/Sinag/internal/torrent"
	"github.com/k22i/Sinag/internal/tracking"
	"github.com/k22i/Sinag/internal/watching"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

// The --background token in each mode (frontend/src/index.css); keep in step
// with windowColours in frontend/src/lib/theme.ts.
var (
	windowColourLight = application.NewRGB(245, 242, 236)
	windowColourDark  = application.NewRGB(14, 13, 12)
)

func main() {
	// Started as a plugin sandbox (#56): run that one call and exit, before
	// anything of the app starts.
	plugins.ServeChild()

	firstmouse.Enable()

	db := store.NewService(store.DefaultPath())
	keychain := secrets.New(secrets.ServiceName)
	// $SINAG_NUVIO_URL stands in for Nuvio's backend, such as the contract
	// tests' self-host (#33). A server the user picks in Settings (#34) is
	// restored over it when the account service starts.
	client := nuvio.New(cmp.Or(os.Getenv("SINAG_NUVIO_URL"), nuvio.DefaultURL), appinfo.Version)
	accounts := account.NewService(client, keychain, db)
	sync := syncer.NewService(db, backend.Nuvio{Client: client, Sessions: account.SessionOf(accounts)})
	// Sending what is queued is the first step of signing out (#30).
	account.FlushOnSignOut(accounts, syncer.PusherOf(sync))
	// Profiles deleted, added or re-PINned elsewhere show at the next sync.
	syncer.RefreshProfilesWith(syncer.PullerOf(sync), account.ProfileRefresher(accounts))
	players := player.NewService(appinfo.Version)
	// Hardware decoding, as Settings › Playback has it (#66).
	player.UseSettings(players, db)
	skipTimes := markers.NewService(appinfo.Version)
	markers.UseSettings(skipTimes, db)
	// How far each film or episode plays becomes the profile's progress, and
	// watched at 90 % (#64). The player shuts down before the syncer, which
	// sends the last of it on the way out.
	watched := watching.New(func() *store.Store { return store.Opened(db) }, syncer.PusherOf(sync).FlushProgress)
	// The anime list maps ids for tracking (#71), the AniList addon (#108)
	// and leaving anime out of Movies and Shows (#109).
	animeList := animelist.New(animelist.DefaultURL, filepath.Dir(store.DefaultPath()))
	anilistClient := anilist.New(anilist.DefaultURL, appinfo.Version)
	// SIMKL and AniList, per profile (#71): scrobbles from the same reports.
	trackers := tracking.NewService(tracking.Config{
		Simkl:           simkl.New(simkl.DefaultURL, cmp.Or(os.Getenv("SINAG_SIMKL_CLIENT_ID"), tracking.SimklClientID), appinfo.Version),
		AniList:         anilistClient,
		AniListClientID: cmp.Or(os.Getenv("SINAG_ANILIST_CLIENT_ID"), tracking.AniListClientID),
		Anime:           animeList,
		Keychain:        keychain,
		Open:            func() *store.Store { return store.Opened(db) },
	})
	// Addon requests the webview's fetch can't make (#37), and the addons
	// built into Sinag (#107): AniList's lists and details (#108).
	addonFetcher := addons.NewService(appinfo.Version)
	addonFetcher.Register(anilistaddon.Name,
		anilistaddon.New(anilistClient, animeList, anilistaddon.KitsuURL, appinfo.Version))
	go animeList.Warm(context.Background())
	// Plugins are off for every profile until its owner turns them on, and
	// never run for a kids profile (#57); their list is the profile's, kept
	// in the store and synced with Nuvio.
	pluginHost := plugins.NewService(appinfo.Version)
	plugins.UseStore(pluginHost, func() *store.Store { return store.Opened(db) }, account.EditorOf(accounts))
	player.ReportTo(players, func(r player.Report) {
		watched.Report(r)
		tracking.Report(trackers, r)
	})
	// Watch parties with Nuvio's apps (ADR-0051): the party keeps the
	// player in step, and the user's pauses and seeks go through it first.
	parties := party.NewService(backend.Parties{Client: client, Sessions: account.SessionOf(accounts)},
		party.Who(db, account.SessionOf(accounts).SignedIn))
	party.UsePlayer(parties, player.DirectOf(players))
	player.GateWith(players, party.GateOf(parties))

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
			// Which IMDb ids are anime, for Movies and Shows (#109).
			application.NewService(animelist.NewService(animeList)),
			application.NewServiceWithOptions(addonFetcher,
				application.ServiceOptions{MarshalError: addons.MarshalError}),
			// Resolving a picked stream to the file the player loads (#53).
			application.NewServiceWithOptions(streams.NewService(appinfo.Version),
				application.ServiceOptions{MarshalError: streams.MarshalError}),
			// Nuvio JS plugins, each call in its own sandbox process (#56),
			// and which ones a profile runs (#57).
			application.NewServiceWithOptions(pluginHost,
				application.ServiceOptions{MarshalError: plugins.MarshalError}),
			// Torrents streamed peer to peer, if the user turns it on (#55).
			application.NewServiceWithOptions(torrent.NewService(db, torrent.DefaultDir(), appinfo.Version),
				application.ServiceOptions{MarshalError: torrent.MarshalError}),
			// Before the player, so it shuts down after it and sends the
			// last stop.
			application.NewServiceWithOptions(trackers,
				application.ServiceOptions{MarshalError: tracking.MarshalError}),
			// libmpv under the webview (#60).
			application.NewService(skipTimes),
			application.NewServiceWithOptions(players,
				application.ServiceOptions{MarshalError: player.MarshalError}),
			// After the player, so it leaves the party first on the way out.
			application.NewServiceWithOptions(parties,
				application.ServiceOptions{MarshalError: party.MarshalError}),
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
	puller, pusher := syncer.PullerOf(sync), syncer.PusherOf(sync)
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
		puller.Background(context.Background())
		importTracked(trackers, db)
	})
	// Focus also retries pushes that failed, such as after being offline (#30).
	window.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) {
		puller.Background(context.Background())
		pusher.Background(context.Background())
		importTracked(trackers, db)
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// importTracked imports SIMKL's and AniList's watches for the profile in
// use (#74, #105), at most every 15 minutes.
func importTracked(trackers *tracking.Service, db *store.Service) {
	if s := store.Opened(db); s != nil {
		if profile, ok, err := s.ProfileInUse(); err == nil && ok {
			trackers.ImportSoon(profile.ID)
		}
	}
}
