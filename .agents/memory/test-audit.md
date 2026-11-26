---
name: test-audit
description: 2026-11-26 audit of all 2285 tests (139 vitest files/1605 tests, 123 Go files/680 tests) to find deletable ones; 20 deleted, and why the suite resists trimming
metadata:
  type: project
---

On 2026-11-26 every test was audited (10 parallel readers, one per area, each cross-checking the subject and the covering test) to find tests worth deleting for CI time. **Only 20 of 2285 were bad**; the rest is dense, deliberate coverage — route tests here are mostly the sole coverage of their screen, and the Go packages have almost no copy-paste.

Deleted (all verified as covered elsewhere): `lib/discover` "lists the genres" (self-comparing, could never fail), `lib/downloads` "is what a refused call says" (`downloadErrorText` is `reasonText`), `routes/search` "shows a query from the address" (subset of the clears-the-field test), `router` "shows the app version" (third copy of the same "1.2.3" assertion, see [[test-suite-green]]), `ios` "leaves the picture controls out of Playback" (same assertions as `routes/settings` "keeps the rows it applies"), `scroll-rail` "leaves the wheel to the page" (no wheel handler exists), `title-menu` "removes a library title from the library's card menu" (`routes/library` "removes a title from the card's context menu, with Undo" is a superset), the three `lib/party` `matchesPartySource` tests and `lib/tracking` "names the services that would take a status" (dead exports), and six style-only tests that pin Tailwind class strings / `data-slot` internals from #123/#143 (`sign-in` ×2, `qr-sign-in`, `profiles`, `title` round buttons, `settings` sliding pill). Go: `store` `TestGuestQueuesNoPushes` (TestOutbox does it), `secrets` `TestAvailable` (TestService does it), `player` `TestMarshalError` (delegates to `playback.MarshalError`, tested there).

**Left alone on purpose** — do not re-flag these: "same assertions, different role" pairs (`routes/player` host vs guest Streams/next-episode, `routes/streams` host vs guest party card) assert that a party role does *not* gate a control, which is ADR-0063; absence guards for removed UI (`.toBeNull()` on "Play the party's source", `gallery` "is dark only, no appearance switch" #143) fail if the feature comes back; `backend` `TestMergePluginRepos` shares 8 rows with `TestMergeAddons` but its two `c!` EXTERNAL_DEX rows are unique.

Consequences to know: `searchGenres` (lib/search.ts), `matchesPartySource` (lib/party.ts) and `servicesFor` (lib/tracking.ts) now have **no test**; the last two have no caller in `src` at all and should be deleted as dead code.

**Why:** the deleted tests carried the least signal and only ~1.2 s of the suite's ~258 s of test time, so trimming tests is not the lever for pipeline speed.
**How to apply:** the cost is per-file setup plus whole-app renders — `routes/player` (92 tests, 27 s), `routes/streams` (60, 36 s), `routes/profiles` (40, 23 s), `routes/settings` (29, 17 s), `routes/home` (24, 15 s); Go serial is 194 s, led by `internal/account` 29 s, `store` 28 s, `downloads` 27 s, `syncer` 22 s, `torrent` 17 s (the CI `go` job adds `-race`). Speed comes from sharding/parallelising those, not from deleting tests. Local gotcha: `go test ./internal/player` needs `PKG_CONFIG_PATH="$(brew --prefix libarchive)/lib/pkgconfig"` or cgo fails on mpv's libarchive (see [[local-node-version]] for the node twin).
