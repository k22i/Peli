---
status: accepted
date: 2026-10-19
---

# The Nuvio client is Go over plain HTTP, not supabase-js

**Go.** Sinag talks to Nuvio from Go, in `internal/nuvio`: plain `net/http` calls to the Supabase endpoints Nuvio's backend exposes (`/auth/v1/*` for sign-in, `/rest/v1/rpc/*` for everything else). The webview never calls Nuvio and never holds a token. This changes how ADR-0004 is carried out, not what it decides. ADR-0004 and the M0 spike said "a thin supabase-js layer". The M0 spike used supabase-js because it was a quick Node script. #20 built the first real client.

## Why

- **Tokens stay out of the webview.** The session lives in the OS keychain (ADR-0007). The account service reads and writes it there itself, so the frontend gets back a profile, never a token. If supabase-js ran in the webview, every token would pass through JavaScript and supabase-js would want to persist the session somewhere (by default, `localStorage`). We'd have to keep that turned off.
- **One refresher.** Supabase rotates refresh tokens on use, so two parallel refreshes can sign the user out (spike gotcha 6). In Go there's one process and one lock. #22 adds refresh there.
- **The surface is small.** Sign-in is one `POST /auth/v1/token`. Each sync call is an RPC `POST` with a JSON body. The client adds the publishable key (read at runtime from `/.well-known/nuvio`), the honest user agent, full-jitter backoff on 429, and typed errors. The `supabase-go` libraries are community-maintained and would add more than they save.
- **The sync loop is in Go anyway.** Pulls, pushes and the outbox (#28–#31) sit next to the local store, which is Go (ADR-0006). The client is there already.

## What we give up

- **Supabase's own client handles some edge cases for us:** PKCE, OAuth, realtime. We use none of them now. If realtime arrives (there's no client-facing channel today), a WebSocket client in Go is a contained addition.
- **Error shapes are ours to keep up to date.** GoTrue and PostgREST errors are mapped in one place (`answerError`), and contract tests (#33) and the per-release live check (`SINAG_NUVIO_LIVE=1 go test -run TestLive ./internal/nuvio/`) keep it honest.

## Nuvio has changed since M0: no `register_current_session` for us

ADR-0004 asked us to call `register_current_session` so users can see and revoke Sinag in their Nuvio session list. Live now rejects any client name other than Nuvio's own (`Nuvio Web`, `Nuvio Mobile`, `Nuvio TV`, `Nuvio Desktop`) with `22023 Unsupported Nuvio client`, and `list_my_sessions` only lists those. Upstream `self-host` at `30f1568` (2026-10-16) has the same allowlist; the spike's pin, `39ea2bd`, didn't. Sinag won't call itself a Nuvio app, so it doesn't register. As a result, Nuvio's session list doesn't show Sinag. Users can still end Sinag's session by signing out in Sinag (#22), or by signing out everywhere in Nuvio. Asking Nuvio to accept a third-party client name is part of #93.
