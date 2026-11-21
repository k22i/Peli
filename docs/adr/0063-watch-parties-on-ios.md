---
status: accepted
date: 2026-11-21
---

# Watch parties on iOS: the party joins the build, and suspension closes its socket, not its seat

Supersedes parts of two earlier decisions: [ADR-0055](0055-ios-on-wails.md) left watch parties out of the iOS build, and [ADR-0058](0058-ios-playback-engine.md) left the party off the player screen. Watch parties now work on iPhone and iPad (ADR-0051's design, unchanged).

ADR-0055 kept the party out for App Review's sake, listed with torrent streaming, the plugin sandbox and the updater. That reason doesn't survive looking at what a party carries: play, pause, seek and chat, over Nuvio's own `watch_party_*` functions and the private realtime channel (`internal/nuvio/realtime.go`, coder/websocket). In a party each member plays their own stream from their own debrid account, so no video, audio or file ever goes between people: there is no peer-to-peer content, which is what App Review's problem with torrents is about. On the wire a party is the same kind of traffic as the sync loop the iOS build already runs. **pion, anacrolix, goja, plugins, updates and firstmouse stay out.** The boundary test enforces it: `ios_boundary_test.go` no longer forbids `internal/party` and now requires `internal/party` and `github.com/coder/websocket` in the iOS dependency list, and the binary grep in `.github/workflows/ios.yml` drops `party`.

**The service is shared, not a desktop extra.** The `peli` struct in `main.go` keeps `parties *party.Service`, created in `newPeli` right after the player, with `party.UsePlayer(p.parties, player.DirectOf(p.players))` and `player.GateWith(p.players, party.GateOf(p.parties))`. `extras` lost its party field, `main_desktop.go` lost its party lines, and `services()` registers it with `party.MarshalError` right after the player, so the desktop order is what it was.

## The player's gate on iOS

`internal/player/service_ios.go` gains what the player has on the desktop: `GateWith(s, g)`, `Direct`, `DirectOf(s)` and the gated `SetPaused`, `Seek`, `SeekBy`, `Scrub` and `SetSpeed`. Validation comes first, as on the desktop, a `UserSeek` is honoured, `SeekBy` is a gated `Seek`, `Scrub` calls `UserScrub`, and `Direct` — the party's own corrections — calls the engine. `GateWith` and `DirectOf` are plain functions, not methods, so Wails doesn't bind them; the bound method list is unchanged, and no cgo was added. `gate_ios_test.go` (build tag `ios`) covers it.

## Away and back

The websocket dies when iOS suspends the app, and Realtime's own reconnect loop would spin while it can't connect. So suspension closes the channel on purpose instead of leaving the reconnect loop to fail: `party.Away(s)` and `party.Back(s)` in `internal/party/suspend.go`, plain functions, called from `main_ios.go`.

- **Away** runs in the background task, right after `engine.Suspend`. It closes the channel, keeps the session and the seat, and sends no `leave`: a host away does not end the party.
- **Back** runs in `becomeActive` (`safego.Go`, since it makes network calls) and joins the party again by code:
  - ended or not found: the session finishes with the notice the frontend already has (`ended`);
  - `removed`: finished with `removed`;
  - a network error: the session stays, the channel reopens and the heartbeat finds out later;
  - the same seat: reopen the channel, `applySnapshot`, then `catchUp` through the party's player (which skips the gate), so a guest re-applies the host's playback and a host republishes its own player state;
  - the seat lost: a new session, carrying the playback over.

`session.go`'s `begin` was refactored onto a shared `openChannel` for this. Tests are in `internal/party/suspend_test.go`.

## On the screen

`TouchTopRow` (`touch-chrome.tsx`) carries a bare 44 pt `GlassButton` — the `Users` icon, `aria-label="Watch party"`, lit with a dot while this device is in a party — which opens the same `openParty()` / `PartySheet` as the desktop's W key. `PartySheet` is a `BottomSheet` when `useCompactShell()`: the tab bar hides, the height is `min(44rem, 85dvh)`, and its bottom padding is `max(safe-area, --keyboard-h)` so the chat field stays above the keyboard; the chat list stops `touchstart` so the sheet's drag doesn't hijack scrolls. The chat, panel and members inputs are 16 px and their targets 44 pt on coarse pointers, `/party` is tightened in the compact shell and `PartyStatus` has a 44 pt hit area. `"party"` left `notOnIOS` in `lib/features.ts`; `"w"` left `iosKeysOff`, so an iPad's keyboard opens the party, and `shortcuts.tsx` no longer marks W desktop-only. The player's `Party.Watch` calls were already gated on `feature("party")`, so they simply run now.

## Consequences

- Parties are on both platforms from the same code. Nothing party-specific exists on iOS except the suspension pair and the gate on the iOS player.
- The app that App Review sees now links `internal/party` and coder/websocket. The party needs Nuvio's hosted backend (self-host has neither the functions nor the flag), as before.
- A member who is away is not in the party's presence, which is how loading and buffering are known (`waitingMembers`), so the party stops waiting for them while they're away. The seat and the playback they come back to are kept.

## Not done

- **A real-device check**: a Mac and an iPhone in the same party, playing in step, through a suspend and back. Nothing but the tests above has run it yet.
- **Relaunching after a kill starts with no party.** Party sessions are in memory only, so nothing is persisted and the app comes back without one; the old seat times out on the server. Rejoining on relaunch would need the party id in the store, and is not done.
- ADR-0051's own gaps stand: no `peli://party/<code>` link, no companion seat.
