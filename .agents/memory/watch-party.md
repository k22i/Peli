---
name: watch-party
description: "Watch party (ADR-0051, on iOS since ADR-0063): internal/party + nuvio/realtime.go layout, live-only RPCs, nuvio_realtime=1 flag, player gate/Direct, Away/Back suspension, touch entry, live tests, frontend pieces and test-mock gotchas"
metadata:
  type: project
---

Watch parties join Nuvio's own parties (built 2026-11-11, ADR-0051). Layout: `internal/nuvio/party.go` (watch_party_* RPCs), `internal/nuvio/realtime.go` (Phoenix channel client), `internal/backend/party.go` (`Parties` + type aliases), `internal/party` (Service, `rules.go` sync rules, `session.go`, `playback.go` follow-the-player + gate, `chat.go`, `who.go`). Frontend: `lib/party.ts`, `components/party/*`, `routes/party.tsx`, `shell/party-status.tsx`, player sheet on W, picker `PartySources` card.

**Why:** it's the user's ask to match Nuvio; parties mix Peli and Nuvio clients, so Nuvio's thresholds and payloads are copied as behaviour (re-implemented, Nuvio's code is GPL-3).

**How to apply:**
- Live answers 410 on `/realtime/v1/websocket` without `nuvio_realtime=1` in the query. A join's `ref` must equal its `join_ref`.
- The RPCs exist only on api.nuvio.tv, not self-host: they're in `contract_test.go`'s `liveOnly`, checked by `set -a; source spikes/nuvio-backend/.env; PELI_NUVIO_LIVE_WRITES=1 go test -run 'TestLiveParty|TestLiveTwoMembers' ./internal/nuvio/ ./internal/party/` (creates a party on the real account, ends it, signs out). `update`/`leave`/`end` answer only `{ok:true}`; non-host gets `not_host`.
- User pauses/seeks/speed go through `player.GateWith(players, party.GateOf(parties))`; party corrections use `player.DirectOf` (no gate). New player controls must use the gated methods.
- `Party.Watch(null)` is sent from `PlayerPage` unmount, not `PlayerFile`, so the next episode moves the party for the host.
- Frontend tests: `@bindings/party` is mocked in `src/test/setup.ts` (unmocked, the Wails call goes through stubbed `fetch` and breaks `serve` helpers). `player.test.tsx`'s `Events.On` mock now keeps a Set of listeners per event (root and player both listen to party:notice). Fixtures: `partyState`/`partyMember` in `src/test/fixtures.ts`.
- Baseline on 2026-11-11 before this work: 47 frontend tests and Go tests in anilistaddon, backend, player (picture), plugins, store, torrent already failed; compare against that, not zero.
- Not tried with a real Nuvio app in the party yet; no deep link (`peli://party`) yet.
- **In both builds since 2026-11-21 (ADR-0063).** A party carries only play/pause/seek/chat over Nuvio's websocket, so party is out of `notOnIOS` and `internal/party` and `github.com/coder/websocket` are now *required* in the iOS deps (`ios_boundary_test.go`); pion, anacrolix, goja, plugins, updates and firstmouse stay out, and the iOS CI symbol grep dropped `party`. The service is shared now: `main.go`'s `peli` struct owns `parties`, created in `newPeli` right after the player and registered in `services()` after it; `extras` lost its field and `main_desktop.go` lost its lines.
- **iOS player gate:** `service_ios.go` has `GateWith`/`Direct`/`DirectOf` and gated `SetPaused`/`Seek`/`SeekBy`/`Scrub`/`SetSpeed`, mirroring desktop; `gate_ios_test.go` (`ios` tag). Bound methods and cgo unchanged.
- **Suspension:** `party.Away`/`party.Back` in `internal/party/suspend.go`, plain functions called from `main_ios.go` (Away in `enterBackground` right after `engine.Suspend`; Back in `becomeActive` via `safego.Go`). Away closes the channel on purpose, keeps the session and seat, sends no leave, a host away doesn't end the party; Back rejoins by code: ended/not found → `ended` notice, `removed` → `removed`, network error → keep the session and reopen the channel, same seat → reopen + `applySnapshot` + `catchUp` through `Direct`, lost seat → new seat carrying playback (3 tries, 1 s apart). `session.go`'s `begin` now uses `openChannel`. Tests: `suspend_test.go`.
- **Touch entry:** `TouchTopRow`'s 44 pt button (Users icon, "Watch party", a dot while in a party) opens the same `openParty()`/`PartySheet` as W; on `useCompactShell()` the sheet is a BottomSheet (tab bar hides, `min(44rem,85dvh)`, `pb max(safe-area,--keyboard-h)`, chat list stops `touchstart`). `"w"` out of `iosKeysOff`, so an iPad keyboard opens it. **No relaunch rejoin:** sessions are in memory only, so a relaunch after a kill starts with no party.

Related: [[player-service]], [[sync-module]], [[nuvio-live-account]], [[kids-profiles]], [[ios-port]].
