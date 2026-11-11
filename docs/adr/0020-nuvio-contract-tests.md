---
status: accepted
date: 2026-10-27
---

# Nuvio contract tests: one table of endpoints and answer types, run against the fake on every push and against pinned self-host daily

Nuvio's sync functions are undocumented and can change without notice (#33, PRD risk table). Peli reads them from one package, `internal/nuvio` (ADR-0015). This ADR covers how a change there gets caught before users hit it: what counts as the contract, where it runs, and what self-host can't tell us.

## The contract is the client's own types

`internal/nuvio/contract_test.go` has a table, `contract`, of every endpoint the client calls. Each entry gives the Go type the client reads the answer into (`Profile`, `LibraryEvent`, `tokenAnswer`, …) or says the answer isn't read. The shape check comes from those types by reflection, so it can't fall out of step with the code:

- A field the client reads that is **missing**, or **null** where Go would silently read a zero, fails. Pointer and `omitempty` fields may be missing or null.
- A field whose **JSON type changed** fails. So does a time that isn't RFC 3339, or a fraction where Go wants a whole number.
- **New fields** the client doesn't read are logged, not failed. Nuvio adding a column isn't a break.
- A field the backend is known to leave out is listed as `absent` on its entry, with a note in the client's doc saying not to trust it. The first one was found this way: `sync_patch_profile` answers without `pin_enabled` and `pin_locked_until`. Editing a PIN-locked profile used to clear its lock on the device because of that. `account.EditProfile` now keeps the local PIN state.

Arguments are checked by the backend accepting them: PostgREST matches a function by argument names (`PGRST202` otherwise), so a call that succeeds proves the names. Failures read like this:

```
nuvio contract: POST /rest/v1/rpc/sync_pull_watch_progress_delta: row 0: field "last_watched" is missing (Peli reads it into ProgressEvent.LastWatched)
```

Two checks keep the table complete. `TestContractCoversEveryCall` parses the package's source for endpoint paths and `sync_*` RPC names, and fails if one isn't in the table, or if the table lists one the client no longer calls. `TestContract` fails if any table entry didn't get an answer during the run.

## The cases

`TestContract` calls each endpoint as the client does, and checks the behavior Peli depends on (docs/spikes/nuvio-backend.md):

- full and delta pulls paging at `DeltaLimit` (1,001 items pushed), the cursor being the last event, our own writes coming back, deletes carrying the row;
- the progress throttle (dropped unless 15 s moved or 30 s newer) and the server-built progress key;
- the 90 % watched rule;
- addon replace-all;
- device login: start, then poll, then approval by a second account, then poll, then exchange, once only;
- profile writes and PINs;
- the avatar catalog and its public images;
- the error table: no session, a forged token, a wrong password, a wrong argument name (`PGRST202`) and type (`22P02`), an index outside 1–6, an unknown device code. The 429 row stays with `TestRateLimitBacksOffThenSucceeds`, since flooding a backend would slow every run.

`internal/syncer`'s `TestProgressReachesAnotherDeviceWithin30s` is the integration test and the epic's success metric. The desktop runs the push loop as it ships, the phone pulls every second, and progress must arrive within 30 s. It took 2.2 s against self-host.

## Where it runs

- **Every push, against `nuviotest`'s fake** (the `go` job). The cases are the same, so a change to the fake that drifts from the backend fails here. Running against self-host brought the fake into line: the approve RPC, public avatar images, PostgREST's argument checks, pulls with an out-of-range index answering `[]` (only writes give `P0001`), and the patch answer without PIN fields.
- **Daily and on demand, against self-host** (the `contract` job in `ci.yml`, cron or `workflow_dispatch` with `contract`). It checks out `NuvioMedia/self-host` at a pinned commit, runs `./nuvio setup` and `./nuvio up`, and runs the tests with `PELI_CONTRACT_URL=http://localhost:8000`. Each run signs up throwaway accounts (self-host confirms at once). Other jobs skip the schedule, so the daily run costs one Linux runner. A pinned commit means a failure is Peli's own change, or a deliberate bump. `nuviotest.NewBackend` refuses `api.nuvio.tv`.
- **Per Nuvio release, against live, by hand** (`docs/nuvio-release-checklist.md`). `TestLive` signs in and reads. `TestLiveSync` pushes one progress entry and deletes it, with every answer shape-checked by the same recorder. This catches live drifting from self-host, which no CI job can see. The anonymous-sync error code already differs (`28000` live, `42501` self-host); the client takes both. Live's `sync_pull_profiles` also sends `profile_background_id` and `profile_background_url`, which self-host's pull doesn't (2026-10-27). Peli doesn't read them.

## What we give up

- **Self-host is a stand-in.** It's the same schema as far as #5 could tell, but live can change first. The daily job won't see that; the release checklist and user reports will.
- **The pin needs bumping by hand.** Following self-host's `main` would make the job fail for upstream reasons with no Peli change. The checklist says when to bump it.
- **Behavior is covered only as far as the cases go.** A server-side change in, say, how watched items cascade isn't a shape change and needs its own case.

## Revisit if

Nuvio publishes a schema or versioned API, or the hosted backend gets a test environment Peli may use.
