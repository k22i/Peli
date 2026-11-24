package main

import (
	"cmp"
	"context"
	"embed"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/account"
	"github.com/k22i/Peli/internal/addons"
	"github.com/k22i/Peli/internal/anilist"
	"github.com/k22i/Peli/internal/anilistaddon"
	"github.com/k22i/Peli/internal/animelist"
	"github.com/k22i/Peli/internal/appinfo"
	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/diagnostics"
	"github.com/k22i/Peli/internal/downloads"
	"github.com/k22i/Peli/internal/haptics"
	"github.com/k22i/Peli/internal/licences"
	"github.com/k22i/Peli/internal/markers"
	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/pairing"
	"github.com/k22i/Peli/internal/party"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/previews"
	"github.com/k22i/Peli/internal/quickactions"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/shell"
	"github.com/k22i/Peli/internal/simkl"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
	"github.com/k22i/Peli/internal/syncer"
	"github.com/k22i/Peli/internal/tracking"
	"github.com/k22i/Peli/internal/watching"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

// The --background token (frontend/src/index.css); keep in step with
// windowColour in frontend/src/lib/theme.ts. Peli is dark only (#143).
var windowColourDark = application.NewRGB(14, 13, 12)

// What the app is, for the application's options on every platform.
const description = "A desktop client for Stremio-compatible addons, with Nuvio sync"

// peli is the services both builds share: everything the iOS build (ADR-0055)
// has, and the desktop build adds to. main_desktop.go and main_ios.go decide
// the rest: which platform services join them, the window, and what the
// window's and the app's lifecycle do.
//
// Nothing here may import a package the iOS build leaves out (torrent,
// plugins, updates, firstmouse, the libmpv engine); ios_boundary_test.go checks
// the dependency list.
type peli struct {
	db        *store.Service
	keychain  *secrets.Keychain
	accounts  *account.Service
	sync      *syncer.Service
	skipTimes *markers.Service
	// streams resolves a picked stream (#53); downloads (#85, ADR-0064) uses
	// it to resolve the links it fetches.
	streams   *streams.Service
	downloads *downloads.Service
	watched   *watching.Reporter
	trackers  *tracking.Service
	// Copying SIMKL, AniList and the TMDB key to another device (#133).
	pairing *pairing.Service
	// players is the libmpv Service on the desktop and the stub or iOS engine
	// host on iOS: the same bound methods either way.
	players *player.Service
	// previews makes the player's seek-bar thumbnails.
	previews *previews.Service
	// parties is the watch party (ADR-0051): it follows the player and the
	// user's pauses and seeks go through it first (party.UsePlayer and
	// player.GateWith, below). Nuvio's backend keeps the membership, so the
	// party works on both builds.
	parties *party.Service

	// diag is the logs, crash files and the frontend's error reports
	// (#127): main_desktop.go and main_ios.go make it, before newPeli.
	diag *diagnostics.Service

	client       *nuvio.Client
	animeList    *animelist.List
	addonFetcher *addons.Service
}

// newPeli builds the services around the database at dbPath.
func newPeli(dbPath string) *peli {
	p := &peli{}
	p.db = store.NewService(dbPath)
	p.keychain = secrets.New(secrets.ServiceName).MovesFrom(secrets.LegacyServiceName)
	// $PELI_SIMKL_URL and $PELI_ANILIST_URL stand in for the trackers the same
	// way, for the fakes the simulator rig runs (tools/iosrig).
	// $PELI_NUVIO_URL stands in for Nuvio's backend, such as the contract
	// tests' self-host (#33). A server the user picks in Settings (#34) is
	// restored over it when the account service starts.
	p.client = nuvio.New(cmp.Or(os.Getenv("PELI_NUVIO_URL"), nuvio.DefaultURL), appinfo.Version)
	p.accounts = account.NewService(p.client, p.keychain, p.db)
	p.sync = syncer.NewService(p.db, backend.Nuvio{Client: p.client, Sessions: account.SessionOf(p.accounts)})
	// Sending what is queued is the first step of signing out (#30).
	account.FlushOnSignOut(p.accounts, syncer.PusherOf(p.sync))
	// Profiles deleted, added or re-PINned elsewhere show at the next sync.
	syncer.RefreshProfilesWith(syncer.PullerOf(p.sync), account.ProfileRefresher(p.accounts))
	p.players = player.NewService(appinfo.Version)
	p.previews = previews.NewService(openPreview, appinfo.Version)
	// Watch parties with Nuvio's apps (ADR-0051): the party keeps the player
	// in step, and the user's pauses, seeks and speed changes go through it
	// first, so it can publish them or refuse them.
	p.parties = party.NewService(backend.Parties{Client: p.client, Sessions: account.SessionOf(p.accounts)},
		party.Who(p.db, account.SessionOf(p.accounts).SignedIn))
	party.UsePlayer(p.parties, player.DirectOf(p.players))
	player.GateWith(p.players, party.GateOf(p.parties))
	p.skipTimes = markers.NewService(appinfo.Version)
	markers.UseSettings(p.skipTimes, p.db)
	p.streams = streams.NewService(appinfo.Version)
	p.downloads = downloads.NewService(downloads.Config{
		Open:    func() *store.Store { return store.Opened(p.db) },
		Resolve: p.streams.Resolve,
		Markers: p.skipTimes.Segments,
		Root:    filepath.Join(filepath.Dir(dbPath), "Downloads"),
		Version: appinfo.Version,
	})
	// How far each film or episode plays becomes the profile's progress, and
	// watched at 90 % (#64). The player shuts down before the syncer, which
	// sends the last of it on the way out.
	p.watched = watching.New(func() *store.Store { return store.Opened(p.db) }, syncer.PusherOf(p.sync).FlushProgress)
	// The anime list maps ids for tracking (#71), the AniList addon (#108)
	// and leaving anime out of Movies and Shows (#109).
	p.animeList = animelist.New(animelist.DefaultURL, filepath.Dir(dbPath))
	// On iOS the launch download waits for Wi-Fi (#128); nil on the desktop.
	if animeListDownloads != nil {
		p.animeList.OnlyWhen(animeListDownloads)
	}
	anilistClient := anilist.New(cmp.Or(os.Getenv("PELI_ANILIST_URL"), anilist.DefaultURL), appinfo.Version)
	// SIMKL and AniList, per profile (#71): scrobbles from the same reports.
	p.trackers = tracking.NewService(tracking.Config{
		Simkl:           simkl.New(cmp.Or(os.Getenv("PELI_SIMKL_URL"), simkl.DefaultURL), cmp.Or(os.Getenv("PELI_SIMKL_CLIENT_ID"), tracking.SimklClientID), appinfo.Version),
		AniList:         anilistClient,
		AniListClientID: cmp.Or(os.Getenv("PELI_ANILIST_CLIENT_ID"), tracking.AniListClientID),
		Anime:           p.animeList,
		Keychain:        p.keychain,
		Open:            func() *store.Store { return store.Opened(p.db) },
	})
	// Pairing copies the trackers' grants and the TMDB key between devices
	// over the local network (#133, ADR-0061).
	p.pairing = pairing.NewService(pairing.Sources{
		Open:     func() *store.Store { return store.Opened(p.db) },
		Tracking: p.trackers,
		Keychain: p.keychain,
	})
	// Addon requests the webview's fetch can't make (#37), and the addons
	// built into Peli (#107): AniList's lists and details (#108).
	p.addonFetcher = addons.NewService(appinfo.Version)
	p.addonFetcher.Register(anilistaddon.Name,
		anilistaddon.New(anilistClient, p.animeList, anilistaddon.KitsuURL, appinfo.Version))
	safego.Go("animelist: download", func() { p.animeList.Warm(context.Background()) })
	player.ReportTo(p.players, func(r playback.Report) {
		p.watched.Report(r)
		tracking.Report(p.trackers, r)
	})
	return p
}

// extras are the platform services that join the shared ones; nil is left
// out. Where they sit keeps the order the desktop app has always started and
// shut them down in.
type extras struct {
	updates, plugins, torrent application.Service
}

// services lists every service to register, in order.
func (p *peli) services(x extras) []application.Service {
	var list []application.Service
	add := func(s application.Service) {
		if s.Instance() != nil {
			list = append(list, s)
		}
	}
	list = append(list, application.NewService(&appinfo.Service{}))
	// The iOS floating tab bar (#129) and QR scanner (#133); no-ops on the
	// desktop.
	list = append(list, application.NewServiceWithOptions(&shell.Service{},
		application.ServiceOptions{MarshalError: shell.MarshalError}))
	// Taptic feedback on iOS (#131, #135); a no-op on the desktop.
	list = append(list, application.NewService(&haptics.Service{}))
	// The Home Screen icon menu (#141); a no-op on the desktop.
	list = append(list, application.NewService(&quickactions.Service{}))
	if p.diag != nil {
		list = append(list, application.NewService(p.diag))
	}
	add(x.updates)
	list = append(list,
		application.NewService(&licences.Service{}),
		application.NewService(p.db),
		application.NewService(secrets.NewService(p.keychain)),
		application.NewServiceWithOptions(p.accounts,
			application.ServiceOptions{MarshalError: account.MarshalError}),
		application.NewService(p.sync),
		// Which IMDb ids are anime, for Movies and Shows (#109).
		application.NewService(animelist.NewService(p.animeList)),
		application.NewServiceWithOptions(p.addonFetcher,
			application.ServiceOptions{MarshalError: addons.MarshalError}),
		// Resolving a picked stream to the file the player loads (#53).
		application.NewServiceWithOptions(p.streams,
			application.ServiceOptions{MarshalError: streams.MarshalError}),
	)
	add(x.plugins)
	add(x.torrent)
	// Downloads for offline viewing (#85): after streams, so it shuts down
	// (checkpointing its job) before streams and the store.
	list = append(list, application.NewServiceWithOptions(p.downloads,
		application.ServiceOptions{MarshalError: downloads.MarshalError}))
	list = append(list,
		// Before the player, so it shuts down after it and sends the last
		// stop.
		application.NewServiceWithOptions(p.trackers,
			application.ServiceOptions{MarshalError: tracking.MarshalError}),
		application.NewServiceWithOptions(p.pairing,
			application.ServiceOptions{MarshalError: pairing.MarshalError}),
		application.NewService(p.skipTimes),
		application.NewServiceWithOptions(p.players,
			application.ServiceOptions{MarshalError: player.MarshalError}),
		// Seek-bar thumbnails for the player.
		application.NewService(p.previews),
	)
	// After the player, so it leaves the party first on the way out.
	list = append(list, application.NewServiceWithOptions(p.parties,
		application.ServiceOptions{MarshalError: party.MarshalError}))
	return list
}

// importTracked imports SIMKL's and AniList's watches for the profile in
// use (#74, #105), at most every 15 minutes.
func (p *peli) importTracked() {
	if s := store.Opened(p.db); s != nil {
		if profile, ok, err := s.ProfileInUse(); err == nil && ok {
			p.trackers.ImportSoon(profile.ID)
		}
	}
}

// pullAndPush is what bringing the app to the front does: pull from Nuvio, and
// retry the pushes that failed, such as after being offline (#29, #30), and
// import SIMKL's and AniList's watches.
func (p *peli) pullAndPush() {
	ctx := context.Background()
	syncer.PullerOf(p.sync).Background(ctx)
	syncer.PusherOf(p.sync).Background(ctx)
	p.importTracked()
}
