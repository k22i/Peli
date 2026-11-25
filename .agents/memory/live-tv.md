---
name: live-tv
description: "Live TV (ADR-0066, built 2026-11-25): internal/livetv layout, the livetv bucket (migration 6), URLs in the keychain, lib/livetv.ts, /live list + guide, LivePlayer branch, Settings pane, conditional nav entry; gotchas, the desktop live-check rig, open items"
metadata:
  type: project
---

Live TV (ADR-0066) is IPTV from M3U playlists, with XMLTV guides, kept per profile on this device. It was built on 2026-11-25 by nine Rex vibe workers against a contract commit.

**Layout**
- **Go, `internal/livetv`:**
  - `livetv.go`: types, codes, `livetv:updated`, the `Keychain` interface.
  - `m3u.go` and `channels.go`: `ParsePlaylist`, and `ChannelsOf`, which gives stable ids `<source>:<sha256(tvg-id, name, group)[:12]>` with a `~2` suffix for duplicates.
  - `xmltv.go` and `match.go`: a streaming `ParseGuide` (window from 2 h back to 36 h ahead), and `Matcher` (tvg-id first, then `NormaliseName`).
  - `fetch.go`, `cache.go`, `refresh.go` and `service.go`.
- **Store:** the `livetv` device bucket (migration 6, `testdata/schema-6.db`) holds only id, profile, name and times. Favourites and recent channels are `livetv-favourites`/`livetv-recent` keys in the profile's bucket.
- **Keychain:** the URLs live under `livetv.<id>.playlist` and `livetv.<id>.guide`.
- **Cache:** `os.UserCacheDir()/Peli/livetv/<id>/{playlist,guide,status}.json`, files 0600, since they hold the channel links.
- **Bindings** all take `profileID`: Sources, AddSource, RemoveSource, RenameSource, Refresh, Channels, Guide, NowNext, Stream, Favourites, SetFavourite, Recent.
  - `Channels` never returns a stream URL; `Stream` hands one over at play time, with Origin `livetv:<id>`.
  - For a kids profile, `Sources` answers `[]` and every other call refuses with `kids_profile`.
- **Frontend:**
  - `lib/livetv.ts`: the queries under `["livetv", profileId, …]`, `useLiveTVEvents` (mounted in `__root`), `usePlayChannel`, the group, filter and guide helpers, and `liveSearch`.
  - `/live` (`components/livetv/live-page.tsx`, `channel-list.tsx`, `guide-grid.tsx`, `guide-details.tsx`).
  - `PlayerPage` renders `components/player/live-player.tsx` when the history state has `player.live`.
  - Settings › Live TV (`components/settings/livetv-pane.tsx`, `livetv-dialogs.tsx`).
  - The nav entry: `liveSection` in `sections.ts` (not one of ⌘1–6), with `useNavSections()`/`withLive` in `lib/nav-sections.ts`, used by the top bar, iPad sidebar, tab bars and palette. The iOS icon is `build/ios/Assets.xcassets/TabLiveTV.imageset`.
- **mpv:** `State.Seekable` comes from mpv's `seekable` property on both engines. The live player shows a seek bar and "Go live" only when it's true.

**Why:** Xtream `get.php` links and their channel links carry a username and password, so nothing URL-shaped goes into the store, logs or error text. The live player is its own small screen, so the 3,700-line film player needed no gating.

**How to apply / gotchas**
- **Never ask for the current profile from shell code.** `useLiveTVAvailable` reads `currentProfileQuery` with `enabled: false`. Asking the store from the nav made a Guest on the welcome screen, so first-run sign-in landed on "Who's watching?" (fixed in e4b0e4f).
- iptv-org's `group-title` holds `;`-separated categories. `groupKeys()` splits them, and a channel gets a chip for each.
- Adding a route with its own `view` search param broke Library's relative `to: "."` reducers. They now use `useNavigate({ from: "/library" })`.
- Generated bindings make slice fields nullable (`categories`, `programmes`). Use `?? []`.
- **Desktop live-check rig** (temporary, never commit):
  - Add a file with `rigAssets` (`POST /__dev/out` appends to out.txt) and `rigStart` (polls `cmd.js` into `window.ExecJS`), and wire both into `main_desktop.go`.
  - Run `wails3 task darwin:package`, copy `bin/Peli.app` aside, revert, and rebuild clean at the end.
  - Launch the copied binary directly (not `open`), with `PELI_DATA_DIR`, `PELI_RIG_DIR` and `PELI_NUVIO_URL=http://127.0.0.1:9`, then "Continue as guest".
  - Bring the window to the front (`osascript … frontmost`) before driving it: a hidden WKWebView throttles timers and `screencapture -l` comes out blank.
  - For a kids check, a throwaway `go run` program against the rig's store can make a profile with `NuvioIndex` + `PinEnabled`, call `SetKids`, then clear `PinEnabled`; otherwise the PIN gate hides everything.
- Test playlists live in `~/rex-work/staysh/livetv-test` (Pluto, whose ids match `i.mjh.nz/PlutoTV/us.xml.gz`). The iptv-org US list has dead and geo-blocked channels, which are good for the "Channel unavailable" path.

**Open items (2026-11-25)**
- In the guide, a programme that began before the visible span has its title hidden under the sticky channel column. The block's `overflow-hidden` defeats a sticky title.
- Now/next was seen but not watched rolling over (it refetches every 60 s).
- Not run on Windows or iOS devices; iOS compiles, the vet and boundary tests pass, and the tab icon exists.
- The touch channel-strip swipe is only covered by tests.
- Under the full suite, `profiles.test.tsx` sometimes logs an unhandled `fetch failed` rejection. It predates Live TV and passes on its own.

Related: [[downloads]], [[kids-profiles]], [[player-service]], [[settings-panes]], [[app-shell]], [[rex-workers]], [[orca-worker-model]].
