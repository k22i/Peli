//go:build ios

package main

import (
	"context"
	"log"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/syncer"
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
// update, first-mouse handling or libmpv engine yet (the iOS engine arrives
// in Phase 5; until then the player Service answers "not available yet").
// The frontend's bindings for the left-out services stay generated, and a
// call to one fails with "unknown bound method" (see docs/adr/0055).
func main() {
	p := newPeli(store.DefaultPath())

	app := application.New(application.Options{
		Name:        "Peli",
		Description: description,
		Services:    p.services(extras{}),
		Assets: application.AssetOptions{
			Handler: devAssets(application.AssetFileServerFS(assets)),
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

	devStart(app, window, p)

	// Pull from Nuvio once the app is up, so the cached UI never waits for it.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if !app.Env.IsDarkMode() {
			window.SetBackgroundColour(windowColourLight)
		}
		syncer.PullerOf(p.sync).Background(context.Background())
		p.importTracked()
	})
	// Coming to the front is what the desktop's window focus is: pull, retry
	// the pushes that failed while offline or suspended, import (#29, #30).
	// The first one follows the launch, which the pull's throttle absorbs.
	app.Event.OnApplicationEvent(events.IOS.ApplicationDidBecomeActive, func(*application.ApplicationEvent) {
		p.pullAndPush()
	})
	// Going to the background sends how far playback got (Pusher.FlushProgress
	// keeps the watched grace) inside a background-task window, since the
	// process is suspended soon after and goroutines and sockets stop with it.
	// TODO(Phase 6): the player engine must report its last position before
	// this runs, and the Nuvio connection monitor and push timers need
	// checking across a suspend (docs/ios-port-audit.md §8 phase 6).
	app.Event.OnApplicationEvent(events.IOS.ApplicationDidEnterBackground, func(*application.ApplicationEvent) {
		application.IOS.BeginBackgroundTask(int(backgroundFlush / time.Second))
		go func() {
			defer application.IOS.EndBackgroundTask()
			ctx, cancel := context.WithTimeout(context.Background(), backgroundFlush)
			defer cancel()
			if err := syncer.PusherOf(p.sync).FlushProgress(ctx); err != nil {
				log.Printf("flushing progress on the way to the background: %v", err)
			}
		}()
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
