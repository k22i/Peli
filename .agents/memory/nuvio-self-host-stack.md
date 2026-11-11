---
name: nuvio-self-host-stack
description: "How to run NuvioMedia/self-host locally for Peli tests without clashing with the user's other Docker projects, and keeping the Mac awake"
metadata:
  node_type: memory
  type: reference
  originSessionId: 4fce3fbb-25e8-4baa-b26f-5f1a197a0e81
  modified: 2026-10-19T12:18:24.782Z
---

Running a local Nuvio backend (as in #22, 2026-10-19):
- Clone `NuvioMedia/self-host` into the session scratchpad (earlier clones get deleted with old scratchpads; stale `nuvio-*` containers from them may remain, leave them).
- `./nuvio setup --no-import-account`, then edit `.env`: `COMPOSE_PROJECT_NAME=nuvio22` (or any new name) and e.g. `JWT_EXPIRY=120` for short tokens; `./nuvio up`.
- Port 5432 is taken on the user's Mac (since 2026-10-27 not by `masdan-postgres`, which moved to 4400). Leave it alone and set `POSTGRES_PORT=54333` in `.env` before `./nuvio up`; then supavisor, storage and migrations all come up (#33). Auth/REST are on :8000.
- Throwaway accounts: `POST /auth/v1/signup` with the publishable key from `/.well-known/nuvio` (autoconfirm is on).
- Nuvio's config has `AUTH_REFRESH_TOKEN_REUSE_INTERVAL=120`.
- The Mac goes into maintenance sleep during long unattended runs, which stalls Docker and breaks timing. Wrap long tests in `caffeinate -i`.
- Opt-in Go test: `NUVIO_URL=http://localhost:8000 NUVIO_EMAIL=… NUVIO_PASSWORD=… PELI_LONG_SESSION=10m caffeinate -i go test -run TestLongSession ./internal/account/` (never against live: it signs out globally).

- When supavisor fails, `./nuvio up` stops before starting `storage` and running migrations (#95, 2026-10-20): `docker start <project>-storage-1`, wait for healthy, then `./nuvio migrate` (seeds the 41 stock avatars).
- Don't run the built app with `PELI_NUVIO_URL` pointed at self-host: the keychain's live session (one service name, "Peli") would be refused and deleted. Test self-host from Go (`NUVIO_URL=… go test -run TestSelfHostProfiles ./internal/account/` signs up its own account).
- `./nuvio down` when done; it keeps the data.

Related: [[nuvio-live-account]], [[spike-ticket-workflow]]
