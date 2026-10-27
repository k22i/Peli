# Architecture decision records

Decisions that are hard to reverse, surprising without context, and the result of a real trade-off. One file per decision, numbered in order. A changed decision gets a new ADR that supersedes the old one.

| ADR | Decision | Date |
|---|---|---|
| [0001](0001-libmpv-in-process-on-every-os.md) | libmpv in-process on every OS, not an mpv child process | 2026-10-12 |
| [0002](0002-video-host-per-os.md) | How video reaches the window, per OS | 2026-10-12 |
| [0003](0003-mit-app-with-our-own-lgpl-libmpv.md) | The app stays MIT; we build and bundle our own LGPL libmpv | 2026-10-12 |
| [0004](0004-nuvio-hosted-backend-go.md) | Use Nuvio's hosted backend; ask Nuvio early | 2026-10-12 |
| [0005](0005-nfr-targets-after-m0.md) | Non-functional targets after M0 | 2026-10-12 |
| [0006](0006-local-store-bbolt.md) | Local storage is a bbolt key-value file, not SQLite | 2026-10-19 |
| [0007](0007-secrets-in-os-keychain.md) | Secrets live in the OS keychain through go-keyring, with no file fallback | 2026-10-19 |
| [0008](0008-nuvio-client-in-go.md) | The Nuvio client is Go over plain HTTP, not supabase-js | 2026-10-19 |
| [0009](0009-session-lifecycle.md) | The Nuvio session: restored offline, refreshed at launch and halfway, and signing out removes the account's profiles | 2026-10-19 |
| [0010](0010-guest-data-stays-apart.md) | The Guest profile stays apart: signing in never merges guest data into the account | 2026-10-20 |
| [0011](0011-profile-avatars-and-picker.md) | Profile avatars load from Nuvio's storage by URL, and the picker asks at launch when there's more than one profile | 2026-10-20 |
| [0012](0012-profile-changes-go-to-nuvio-first.md) | Profile changes go to Nuvio first, one profile at a time, and are refused offline rather than queued | 2026-10-20 |
| [0013](0013-qr-sign-in-via-nuvio-link.md) | QR sign-in uses Nuvio's device login: a QR code to nuvio.tv/link and a short code, polled in Go | 2026-10-20 |
| [0014](0014-kids-profiles.md) | Kids profiles: a local flag and an allow-list of addons, left with the profile's own PIN | 2026-10-21 |
| [0015](0015-sync-module-backend-interface.md) | The sync module: a data interface and an account interface over one Nuvio client, with an import boundary | 2026-10-21 |
| [0016](0016-delta-pull.md) | The delta pull: Go decides when (launch, focus, interval, profile change), the store decides who wins (latest progress timestamp) | 2026-10-21 |
| [0017](0017-push-loop.md) | The push loop: the store wakes it, progress goes every 30 s, a flush on pause/exit/sign-out, backoff on failure, watched items left to the server | 2026-10-21 |
| [0018](0018-offline-and-reconnect.md) | Offline and reconnect: the connection is learnt from sync traffic, probed only while offline; on reconnect the outbox goes first, then a pull | 2026-10-27 |
| [0019](0019-addon-list-sync.md) | Addon list sync: the whole list on every pull, pushes merged three ways with the server's list, sharing profiles use the primary's | 2026-10-27 |
| [0020](0020-nuvio-contract-tests.md) | Nuvio contract tests: one table of endpoints and answer types, run against the fake on every push and against pinned self-host daily | 2026-10-27 |
| [0021](0021-custom-server.md) | A custom server: one client pointed at it, the URL in the store, the key in the keychain, and switching signs out | 2026-10-27 |
| [0022](0022-home-layout-and-collections.md) | Home layout and collections: pulled from Nuvio's apps, kept as their blobs, pushed only to a custom server | 2026-10-27 |

0001–0005 came out of the M0 gate review ([`../m0-gate-review.md`](../m0-gate-review.md), #8).
