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

0001–0005 came out of the M0 gate review ([`../m0-gate-review.md`](../m0-gate-review.md), #8).
