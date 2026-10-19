---
status: accepted
date: 2026-10-12
---

# Use Nuvio's hosted backend; ask Nuvio early

**Go.** Sinag signs in to and syncs with `api.nuvio.tv` directly, through one sync module (#28) over supabase-js. [#5](../spikes/nuvio-backend.md) showed that email / password sign-in, QR sign-in from the Nuvio phone app, all 20 sync reads with delta cursors, and a progress push (visible in Nuvio mobile right away) all work against live. They use only public inputs: the publishable key is served at `GET /.well-known/nuvio`, so there's no secret to ship. The backend's contract is Nuvio's Apache-2.0 [`self-host`](https://github.com/NuvioMedia/self-host) stack. We build against that schema and run it locally for contract tests (#33), and never read NuvioMobile (GPL-3) or nuvio-web (no licence).

## Conditions

- **We ask Nuvio before we depend on them, not just before launch.** The October 8 decision was to send a courtesy note at launch (#81). But we have no explicit OK to run a third-party client on their hosted service, and its rate limit (900 req/s, apparently shared across all clients) makes our traffic their problem. So we ask during M1, before M2's sync work starts (#93). #81 keeps the pre-launch note and docs review.
- **The sync module behaves like a good guest:** an honest user agent, `register_current_session` so users can see and revoke us, exponential backoff with jitter on 429 (no `Retry-After` is sent), and a few calls per surface. Home layout and collections are never pushed to the official backend.
- **Drift gets caught by tests.** Contract tests run against a pinned `self-host` in CI, plus a small manual live check per release. Live and self-host already differ in one error code.

## If Nuvio says no

M2's account and sync work keeps its shape. It moves behind the custom-server backend (#34, P1 today, which would become P0): the same discovery document and RPCs on a user-supplied URL. Guest mode (#23) covers users without one. The rest of v1 (addons, streams, player) doesn't depend on Nuvio.
