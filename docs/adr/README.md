# Architecture decision records

Decisions that are hard to reverse, surprising without context, and the result of a real trade-off. One file per decision, numbered in order. A changed decision gets a new ADR that supersedes the old one.

| ADR | Decision | Date |
|---|---|---|
| [0001](0001-libmpv-in-process-on-every-os.md) | libmpv in-process on every OS, not an mpv child process | 2026-10-12 |
| [0002](0002-video-host-per-os.md) | How video reaches the window, per OS | 2026-10-12 |
| [0003](0003-mit-app-with-our-own-lgpl-libmpv.md) | The app stays MIT; we build and bundle our own LGPL libmpv | 2026-10-12 |
| [0004](0004-nuvio-hosted-backend-go.md) | Use Nuvio's hosted backend; ask Nuvio early | 2026-10-12 |
| [0005](0005-nfr-targets-after-m0.md) | Non-functional targets after M0 | 2026-10-12 |

0001–0005 came out of the M0 gate review ([`../m0-gate-review.md`](../m0-gate-review.md), #8).
