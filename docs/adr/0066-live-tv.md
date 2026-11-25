---
status: accepted
date: 2026-11-25
---

# Live TV: IPTV channels from M3U playlists, with a guide from XMLTV, parsed and kept in Go per profile

Peli plays films and episodes from addons. IPTV users have M3U playlists (often an Xtream `get.php` link) and XMLTV guides that no addon covers. Live TV adds them as a separate kind of source, with its own page (`/live`) and a live mode in the player.

## Decisions

1. **A source is a playlist URL plus an optional guide URL.** Each URL is `http(s)://`, `file://` or a local path. Without a guide URL, the playlist's `url-tvg` / `x-tvg-url` header is used. Sources belong to a profile and stay on this device: nothing is synced to Nuvio.
2. **Both URLs are secrets.** Xtream links carry a username and password, so the URLs go in the keychain (`internal/secrets`, keys `livetv.<id>.playlist` / `livetv.<id>.guide`). The store's `livetv` bucket (migration 6) keeps only the id, profile, name and timestamps. URLs are never logged, and errors name codes, never URLs. Channel links can carry the same credentials:
   - `Channels` never returns them.
   - `Stream(profile, channel)` hands one over only when the channel plays.
   - The parsed cache that holds them is written `0600`.
3. **Go parses and keeps everything (`internal/livetv`).**
   - **M3U:** `#EXTINF` attributes, the name after the comma, and request headers from `#EXTVLCOPT` and `#EXTHTTP`. It tolerates CRLF line endings, a BOM and entries without attributes.
   - **XMLTV:** read with a streaming `encoding/xml` decoder, gzip detected by its magic bytes. Only playlist channels are kept, within a window from 2 h ago to 36 h ahead. Guides run to 500 MB unzipped, and the window keeps memory small.
   - **Matching:** a guide channel matches by `tvg-id`, then by a normalised display name.
   - **Fetching:** downloads have timeouts and size caps. Parsed results are cached under the user cache folder (`Peli/livetv/<source>`). Playlists refresh after 12 h and guides after 6 h, or by hand with Refresh. Each refresh ends with `livetv:updated`.
4. **Channel ids are stable across refreshes.** Each id is `<source>:<hash of tvg-id, name and group>`, with a suffix for duplicates, so favourites and recently watched channels (per profile, in the profile's bucket) survive a refresh.
5. **Kids profiles never see Live TV.** In Go, `Sources` answers empty and every other method refuses with `kids_profile` (`guardKids`). The UI hides the page, the nav entry and the Settings controls.
6. **The live player is its own screen.** `/player` with `player.live` in history state renders `LivePlayer`, not the film player. The file is loaded with no `Watching`, so Go reports no progress, watched marks or scrobbles. None of the following exist there: next episode, skip markers, downloads, seek previews, the remembered source, the stream switcher or the party entry.
   - What it shows: a LIVE badge and the current programme as the title.
   - The seek bar shows only while mpv reports the stream as `seekable` (a DVR window), with Go live beside it.
   - Page Up / Page Down (on touch, a swipe on the channel strip) move through the current group.
   - A failed channel shows "Channel unavailable" in place of the error screen.
7. **The nav entry is conditional.** `sections` (⌘1–6) is unchanged. Live TV joins the top bar, the iPad sidebar and the tab bars through `useNavSections()` only while the profile has a source.

## Not now (follow-ups)

- Stremio addons' `tv` and `channel` catalogs, and guides from addons.
- Xtream Codes and Stalker portal logins (a `get.php` M3U link works as a plain playlist).
- Recording and catch-up TV.
- Watch parties on live channels.
