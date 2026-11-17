//go:build ios

package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Peli/internal/appinfo"
	"github.com/k22i/Peli/internal/iosplayer"
	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/shell"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/syncer"
	"github.com/k22i/Peli/internal/tracking"
)

// backgroundFlush is how long going to the background gets to send what is
// queued. iOS suspends the app about thirty seconds after
// ApplicationDidEnterBackground at the latest, and less when the system is
// busy.
const backgroundFlush = 20 * time.Second

// main is the iOS app (ADR-0055): Wails' UIKit target runs it from its
// bootstrap (build/ios), in the same process as the webview. Everything the
// App Store build must not contain is left out of this file and of the
// packages it imports: no torrent streaming, plugins, watch parties, auto-
// update or first-mouse handling; the player is internal/iosplayer (libmpv
// in a UIKit view under the webview, Phase 5).
// The frontend's bindings for the left-out services stay generated, and a
// call to one fails with "unknown bound method" (see docs/adr/0055).
func main() {
	p := newPeli(store.DefaultPath())

	app := application.New(application.Options{
		Name:        "Peli",
		Description: description,
		Services:    p.services(extras{}),
		Assets: application.AssetOptions{
			Handler: devAssets(imageProxy(application.AssetFileServerFS(assets))),
		},
		// The signal handler is a no-op on iOS whatever this says (Wails'
		// signal_handler_ios.go); it is set, as in Wails' own iOS template,
		// so a future Wails that honours it doesn't install one.
		DisableDefaultSignalHandler: true,
		IOS: application.IOSOptions{
			// The page scrolls inside its own panes (#content, rows), so the
			// webview itself must not rubber-band or show an indicator.
			DisableBounce:           true,
			DisableScrollIndicators: true,
			// A long press opens a title's menu (Base UI's context menu); the
			// system's link preview would cover it. No Next/Previous/Done bar
			// above the keyboard either.
			DisableLinkPreview:        true,
			DisableInputAccessoryView: true,
			// The player's video plays inline, under the page (Phase 5).
			EnableInlineMediaPlayback: true,
			// The frontend finds out it is the iOS app from this token
			// (lib/platform.ts): Wails doesn't inject its environment on iOS.
			ApplicationNameForUserAgent: "PeliIOS",
			BackgroundColour:            windowColourDark,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Peli",
		BackgroundColour: windowColourDark,
		URL:              "/",
	})

	// libmpv in a view under the transparent webview (ADR-0055). The video
	// host finds the view controller through the window's native handle.
	engine := iosplayer.New(window.NativeWindow, player.SinkOf(p.players), p.db, appinfo.Version)
	// An iPhone stays upright except in the player (rotation_ios.go).
	player.UseEngine(p.players, rotatingEngine(engine))

	// The floating tab bar goes over the webview in the same controller.
	shell.UseWindow(window.NativeWindow)

	devStart(app, window, p, engine)

	// Pull from Nuvio once the app is up, so the cached UI never waits for it.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
		syncer.PullerOf(p.sync).Background(context.Background())
		p.importTracked()
	})

	// UIKit's lifecycle notifications, through the engine (ADR-0059): Wails'
	// application events are queued to a goroutine, so they can't hold the
	// app until the last report is saved, and none was seen to arrive.
	//   - WillResignActive (a call, the app switcher, a swipe home) is the
	//     earliest warning and the last point where the GPU may still be used
	//     safely: Suspend runs to the end inside the notification.
	//   - DidEnterBackground pushes inside a background task.
	//   - DidBecomeActive is the desktop's window focus: pull, retry, import.
	iosplayer.OnLifecycle(iosplayer.Lifecycle{
		WillResign:    func() { log.Printf("lifecycle: will resign active"); engine.Suspend() },
		DidBackground: func() { p.enterBackground(engine) },
		DidActive:     func() { p.becomeActive(engine) },
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// becomeActive is the app coming to the front, or back from suspension: the
// renderer restarts (the player stays paused where it was), Nuvio is pulled
// and pushed, and what the clocks that stopped while suspended were waiting
// for is done now: an offline probe (Monitor.Wake) and the tracking queue.
func (p *peli) becomeActive(engine *iosplayer.Engine) {
	log.Printf("lifecycle: became active")
	engine.Resume()
	p.pullAndPush()
	syncer.WakeOf(p.sync)
	tracking.Kick(p.trackers)
}

// enterBackground is the last thing the app does before iOS suspends it. It
// runs inside a background task and in this order, each step finished before
// the next:
//
//  1. Suspend: GL parked, playback paused, the final report (position,
//     paused) delivered through the sink, which saves it to the store.
//  2. FlushProgress pushes the store's outbox, so the report is in it. The
//     scrobbler sends the pause to SIMKL meanwhile (Drain).
//
// A push that doesn't finish stays in the store's outbox and goes out at the
// next launch or return (the watched mark included).
func (p *peli) enterBackground(engine *iosplayer.Engine) {
	log.Printf("lifecycle: entered the background")
	application.IOS.BeginBackgroundTask(int(backgroundFlush / time.Second))
	go func() {
		defer application.IOS.EndBackgroundTask()
		engine.Suspend()
		ctx, cancel := context.WithTimeout(context.Background(), backgroundFlush-2*time.Second)
		defer cancel()
		var wg sync.WaitGroup
		wg.Go(func() { tracking.Drain(p.trackers, backgroundFlush-4*time.Second) })
		if err := syncer.PusherOf(p.sync).FlushProgress(ctx); err != nil {
			log.Printf("flushing progress on the way to the background: %v", err)
		}
		wg.Wait()
	}()
}
