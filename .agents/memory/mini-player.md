---
name: mini-player
description: "#70 picture-in-picture = the app window made small (Service.SetMini, mini_darwin.m / mini_other.go, State.mini), I key, compact controls; how it was checked without screen capture"
metadata:
  type: project
---

#70 (ADR-0039 "Mini player (#70)"): F25's PiP is the same window shrunk, not a second window or AVPictureInPictureController (video lives under the webview in the app window, and macOS PiP would need frames copied out of OpenGL). `Service.SetMini(on)` needs a session, leaves fullscreen first (waits on the `windowed` channel fed by the UnFullscreen event), and `Stop` always calls `SetMini(false)`. `SetFullscreen(true)` leaves mini first. Both take `windowOps`. macOS: `mini_darwin.m` (floating level, all Spaces + FullScreenAuxiliary, traffic lights hidden, `contentAspectRatio`, frame restored). Windows/Linux: `mini_other.go` with Wails `SetBounds`/`SetAlwaysOnTop`, no aspect lock.

**Why:** later player work (#58, anything on `/player`) must keep the mini layout working and not open big overlays in a 480 px window.

**How to apply:**
- Frontend: `mini` from `useAhead(state.mini)`; `toggleMini` closes help/switcher; `openSwitcher` leaves mini; `?` is a no-op in mini; Esc leaves mini before fullscreen; double click toggles mini. New controls in the bottom bar need a `!mini` decision. `NextEpisode` takes `mini` (no thumbnail, `right-3 bottom-16`).
- Mocks of `@bindings/player` that reach /player need `SetMini` too (player.test.tsx has `mocks.setMini`).
- This session had no screen-recording permission (`screencapture` → "could not create image"). Window size/position came from logging `window.Bounds()` in the dev-play hook ([[player-service]]), and the floating level from CGWindowList `kCGWindowLayer` (3 = floating, 0 = normal).
- Playback fills the screen (visible frame, as a title-bar double click, not fullscreen) when a session opens, and `Stop` calls `restoreWindow` (not `SetMini(false)`), which leaves mini and goes back to the pre-play frame in one move. The fill/restore code lives in `mini_darwin.m` / `mini_other.go` beside the mini state it shares.
- Related: [[player-keys-media]], [[next-episode]], [[stream-switcher]].
