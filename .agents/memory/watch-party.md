---
name: watch-party
description: "Watch party (ADR-0051): internal/party + nuvio/realtime.go layout, live-only RPCs, nuvio_realtime=1 flag, player gate/Direct, live tests, frontend pieces and test-mock gotchas"
metadata:
  type: project
---

Watch parties join Nuvio's own parties (built 2026-11-11, ADR-0051). Layout: `internal/nuvio/party.go` (watch_party_* RPCs), `internal/nuvio/realtime.go` (Phoenix channel client), `internal/backend/party.go` (`Parties` + type aliases), `internal/party` (Service, `rules.go` sync rules, `session.go`, `playback.go` follow-the-player + gate, `chat.go`, `who.go`). Frontend: `lib/party.ts`, `components/party/*`, `routes/party.tsx`, `shell/party-status.tsx`, player sheet on W, picker `PartySources` card.

**Why:** it's the user's ask to match Nuvio; parties mix Sinag and Nuvio clients, so Nuvio's thresholds and payloads are copied as behaviour (re-implemented, Nuvio's code is GPL-3).

**How to apply:**
- Live answers 410 on `/realtime/v1/websocket` without `nuvio_realtime=1` in the query. A join's `ref` must equal its `join_ref`.
- The RPCs exist only on api.nuvio.tv, not self-host: they're in `contract_test.go`'s `liveOnly`, checked by `set -a; source spikes/nuvio-backend/.env; SINAG_NUVIO_LIVE_WRITES=1 go test -run 'TestLiveParty|TestLiveTwoMembers' ./internal/nuvio/ ./internal/party/` (creates a party on the real account, ends it, signs out). `update`/`leave`/`end` answer only `{ok:true}`; non-host gets `not_host`.
- User pauses/seeks/speed go through `player.GateWith(players, party.GateOf(parties))`; party corrections use `player.DirectOf` (no gate). New player controls must use the gated methods.
- `Party.Watch(null)` is sent from `PlayerPage` unmount, not `PlayerFile`, so the next episode moves the party for the host.
- Frontend tests: `@bindings/party` is mocked in `src/test/setup.ts` (unmocked, the Wails call goes through stubbed `fetch` and breaks `serve` helpers). `player.test.tsx`'s `Events.On` mock now keeps a Set of listeners per event (root and player both listen to party:notice). Fixtures: `partyState`/`partyMember` in `src/test/fixtures.ts`.
- Baseline on 2026-11-11 before this work: 47 frontend tests and Go tests in anilistaddon, backend, player (picture), plugins, store, torrent already failed; compare against that, not zero.
- Not tried with a real Nuvio app in the party yet; no deep link (`sinag://party`) yet.

Related: [[player-service]], [[sync-module]], [[nuvio-live-account]], [[kids-profiles]].
