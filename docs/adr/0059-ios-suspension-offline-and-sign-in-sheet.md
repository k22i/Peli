---
status: accepted
date: 2026-11-13
---

# Suspension, interruptions and offline on iOS; AniList sign-in in a sheet over the app

Phase 6 of the iOS port (ADR-0055, ADR-0058) makes what Peli keeps (progress, watched marks, scrobbles) survive the app leaving the screen, being suspended or killed, and the network going away.

## What was decided

- **UIKit's lifecycle notifications, not Wails' application events.** Wails queues `ApplicationWillResignActive` and friends to a goroutine, so Go can never finish before the app leaves, and under the scene delegate (ADR-0056) none of them was seen to arrive in the simulator (Phase 5's `ApplicationDidBecomeActive` → `pullAndPush` had never run). `internal/iosplayer` now observes `UIApplicationWillResignActive`, `DidEnterBackground` and `DidBecomeActive` itself and calls Go on the main thread inside the notification (`iosplayer.OnLifecycle`).
- **The order on the way out is explicit, not a race:**
  1. `WillResignActive` runs `Engine.Suspend` to the end before returning: the renderer is parked (no OpenGL ES command after this point), playback is paused, and the final `Report` (position, paused) goes through the sink, which has saved it to the store (`watching.Reporter`) before it returns.
  2. `DidEnterBackground` opens a background task (20 s) and runs `Suspend` again (idempotent; it waits behind the first), then `Pusher.FlushProgress` and the scrobbler's drain, so the report is in the outbox when it is pushed. A push that doesn't finish stays in the store's outbox and goes out at the next launch or return, the watched mark included.
  3. `DidBecomeActive` restarts the renderer (the player stays paused where it was, the last frame is drawn again; a tap plays), pulls and pushes, probes Nuvio if it was offline (`Monitor.Wake`) and has the tracking queue look at its jobs (`tracking.Kick`).
- **GLES is stopped by design before the app is backgrounded.** iOS kills an app that issues OpenGL ES commands in the background (`gpus_ReturnNotPermittedKillClient`). The simulator doesn't enforce this, so the park (`peli_host_park`: set a flag, then wait for the render queue, so an in-flight draw has been presented) is reasoned, not observed killing anything. A device run is owed. WillResignActive also fires for Control Center, a call or Split View; the picture then stays still and paused until the app is active again, which is acceptable.
- **Background audio, lock-screen controls and Now Playing are deferred.** No `UIBackgroundModes audio`; leaving the screen pauses. (`SetNowPlaying` is still accepted and ignored.)
- **Interruptions and route changes.** An audio-session interruption (call, Siri, alarm) and `OldDeviceUnavailable` (headphones unplugged) pause and send the final report, the same path as Suspend. When an interruption ends the session is made active again and playback **stays paused** even if the system says `shouldResume`: starting by itself after a phone call is a surprise, a tap is cheap. Verified in the simulator by posting the notifications the system would (`pelidev` rig); the OS's own delivery is unverified.
- **Timers.** Go's timers use the monotonic clock, which doesn't count a sleeping device, and nothing runs while the process is suspended, so the push loop's backoff, the pull poll, the offline probes (up to a minute) and the tracking queue's 1-minute timer can all be late by an unknown amount after a return. Everything that matters is therefore restarted by `DidBecomeActive`: the pull and the push (`kick` ignores the backoff), `Monitor.Wake` (probe now, intervals start over) and `tracking.Kick`. Tracking jobs store wall-clock `NextAt`, so they are right across a suspend. No burst: the pusher flushes one at a time, and the overdue timers fire once.
- **The outbox is the store's**, so being killed while suspended loses at most what was never reported: the final report of a pause or background is saved before anything is sent, and the next launch pushes what is queued (verified with `simctl terminate` while offline, on iPhone and iPad).
- **AniList signs in inside a sheet over the app.** Its redirect is `http://127.0.0.1:47613/anilist`, a page Peli serves; opening Safari backgrounds the app and it is suspended within seconds, taking the page down. `appinfo.OpenSignInPage` shows the approval page in an `ASWebAuthenticationSession` (`internal/iosauth`, one cgo file and its Objective-C): the app stays active (no resign in the log), the loopback server answers, and the page's token reaches Go; the frontend dismisses the sheet when the wait ends. The session shares Safari's cookies (an AniList login already there is reused, at the price of the system's one-tap "wants to use … to Sign In" prompt); `PELI_AUTH_EPHEMERAL=1` (rig only) uses a private session with no prompt. Registering a second AniList app with a custom-scheme redirect was not needed. SIMKL's device code works through `openURL` as it is.
- **Offline.** `ConnectionStatus` already sits in the top bar at compact width (icon only below `lg`); verified on iPhone. Progress queues while offline and goes out on return; kids profiles are still refused by `canConnect`.

## Consequences

- A device run is owed for the GL park (does the OS really leave the app alone), VideoToolbox, and the OS's own interruption and route notifications.
- A suspended app can't scrobble: SIMKL's pause is sent inside the background window, and a stop that fails offline is queued and sent later with the time it happened.
- `PELI_SIMKL_URL` and `PELI_ANILIST_URL` join `PELI_NUVIO_URL` as test seams (`tools/iosrig` serves fakes for all three).
