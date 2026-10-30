---
name: player-keys-media
description: "#67 player keys (one window listener, shortcuts.tsx + ? overlay, C/A cycle, slider arrows skipped) and OS media controls (Service.SetNowPlaying, media.go → Now Playing / MPRIS / libmpv SMTC); how to press a media key in a live check"
metadata:
  type: project
---

#67 (ADR-0039 "Keys and media controls"): keys live in the one `onKey` listener in `player-page.tsx` (`repeating` and `once` maps); the list the `?` overlay shows is `playerShortcuts` in `components/player/shortcuts.tsx`, so a new key goes in both. Taken: Space/K, ←→, ↑↓, M, F, Esc, A, C, Z/X, ?. Go: `Service.SetNowPlaying({title, subtitle})` (the screen sends its heading; Stop forgets it), `media.go` hands `mediaState` to `mediaControls` (`media_darwin.m` MPNowPlayingInfoCenter/MPRemoteCommandCenter, `media_linux.go` MPRIS via godbus, Windows = libmpv's own SMTC via `media-controls=yes` + `force-media-title`).

**Why:** #68–#70 add to the same screen and session; #92's Windows libmpv must be built with `win32-smtc` or Windows loses media keys silently.

**How to apply:**
- Every test file that mocks `@bindings/player` and reaches /player needs `SetNowPlaying` in the mock (streams.test.tsx too), or the effect throws.
- Keys with ⌘/Ctrl/Alt are ignored; arrows skip when `event.defaultPrevented` (a focused Base UI slider). Menus open = no player keys (`menuOpen`).
- MPRIS method `Seek` is `SeekBy` in Go (go vet's io.Seeker check), exported with `ExportWithMap`. Linux tests start their own `dbus-daemon` (skip without it): run them in the `staysh-spike-render` Docker image.
- Live media-key check on macOS: a tiny Swift tool posting `NSEvent.otherEvent(.systemDefined, subtype 8, data1 = key<<16 | 0xa00/0xb00)` (16 = play/pause) to `.cghidEventTap`. Only while Sinag plays, or the key goes to Music. Use the dev-play hook from [[player-service]] and capture your window by PID.
- Next/previous track are deliberately off (the next episode is the card's, [[next-episode]]); no artwork yet.
- Related: [[player-controls]], [[player-tracks]], [[player-service]].
