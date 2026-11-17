---
name: ios-small-fixes
description: "#139 small iOS fixes: thisDevice/deviceName wording, Meteor TB🌩️/☁️ markers, SeedAudioLanguages, languageName, About build number, icon appearances + launch colour assets, quiet webview, touch CSS"
metadata:
  type: project
---

#139 (epic #126, built 2026-11-17). Details are in `ios/README.md` → "Small fixes (#139)"; what is easy to miss:

- `thisDevice()` is "this iPhone"/"this iPad"/"this computer"; use `deviceName()` for "your iPhone’s". Shared strings changed only through these, so desktop reads as before.
- Meteor writes `[TB🌩️]` cached / `[TB☁️]` not cached in the stream name; `cacheMarker` in `lib/ranking/parse.ts` knows both. Recorded with the TorBox key from the main checkout's `spikes/stream-ranking/.env` (the worktree has no copy): base64 `{debridService, debridApiKey}` config at `https://meteorfortheweebs.midnightignite.me/<config>/stream/movie/<id>.json`. Listing is read-only; the play URLs resolve and add to TorBox, so never fetch them.
- Audio language seeding is Go-side (`Store.SeedAudioLanguages`, via `store.Service`) so "never saved" is exact; it skips Nuvio-synced profiles. The frontend hook is iOS only.
- Icons and launch colour live in `build/ios/assets` and are copied over Wails' generated catalog in both compile tasks of `build/ios/Taskfile.yml` (`xcode/` is regenerated). `xcrun assetutil --info bin/ios/peli.app/Assets.car` shows the dark and tintable variants.
- `ios:sideload` also copies the `.ipa` to iCloud Drive/Peli/peli.ipa, replacing whatever is there.
- Webview start: `peli_quiet_webview` (host_ios.m) is the only thing main.m calls for it; if the page never calls `appinfo.PageReady` it shows after 4 s.

Related: [[ios-polish-epic]], [[ios-port]].
