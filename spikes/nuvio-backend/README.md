# Spike: Nuvio backend access

Throwaway code for [#5](https://github.com/k22i/Sinag/issues/5). The findings are in
[`docs/spikes/nuvio-backend.md`](../../docs/spikes/nuvio-backend.md). Don't build on this code.

A small CLI over `@supabase/supabase-js` that signs in to a Nuvio backend and exercises the sync functions a desktop client needs. It records shapes, timings, errors and rate-limit headers. It runs on Node ≥ 24 with no build step: Node strips the TypeScript types itself.

- [`src/lib.ts`](src/lib.ts): config, the client (honest `User-Agent`, sessions saved in git-ignored `.session/`), HTTP tracing, and redaction of values to their types.
- [`src/probe.ts`](src/probe.ts): the commands.

The contract was taken from observed behaviour and from Nuvio's own **Apache-2.0** backend, [`NuvioMedia/self-host`](https://github.com/NuvioMedia/self-host) (schema + edge functions). No code was read from or copied from NuvioMobile (GPL-3) or nuvio-web.

## Config

Nothing secret is committed. Put these in `spikes/nuvio-backend/.env` (git-ignored) or the environment:

| Variable | |
|---|---|
| `NUVIO_URL` | Backend. Default `https://api.nuvio.tv`; `http://localhost:8000` for a local self-host stack. |
| `NUVIO_KEY` | Optional. By default the public key is read from `<NUVIO_URL>/.well-known/nuvio`. |
| `NUVIO_EMAIL`, `NUVIO_PASSWORD` | For `signin` (and `signup`, local only). Quote values that contain `#`, or the rest is read as a comment. |
| `NUVIO_PROFILE` | Profile index (1–6). Default 1. |
| `NUVIO_TV_LOGIN_URL` | Base URL encoded in the QR. Default `https://nuvio.tv/tv-login`. |

## Commands

```sh
npm install
node src/probe.ts discover                 # discovery document (key redacted)
node src/probe.ts signin                   # email/password
node src/probe.ts tv-login                 # QR / device-code: prints a QR, polls, exchanges
node src/probe.ts catalog                  # every read function: shape, rows, ms
node src/probe.ts pull                     # full delta pull of library / progress / watched from cursor 0
node src/probe.ts push-progress <id> [movie|series] [season episode]   # push one entry, time a 2nd session seeing it
node src/probe.ts delete-progress <id>     # undo push-progress; shows the delete event
node src/probe.ts push-throttle <id>       # local backend only: shows which pushes the server silently drops
node src/probe.ts errors                   # error cases and their codes
node src/probe.ts ratelimit [n]            # local backend only: floods until 429
```

Results go to `results/<live|local>-<command>.json` with values replaced by their types. Raw responses (`results/raw/`) hold account data and are git-ignored.

## Local backend

`NuvioMedia/self-host` runs the same stack locally (`./nuvio setup && ./nuvio up`, then `NUVIO_URL=http://localhost:8000`). `signup` creates throwaway accounts there, and `approve <code>` with `PROBE_SESSION=<other session>` stands in for the phone in the QR flow.
