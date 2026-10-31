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
| [0023](0023-addon-protocol-client.md) | The addon protocol client: TypeScript in the webview, lenient parsing, Go only as a fetch fallback | 2026-10-29 |
| [0024](0024-addon-manager.md) | The addon manager: one Go edit per action, shown at once, reconfigure in place keeping a kids allow-list | 2026-10-29 |
| [0025](0025-virtualized-rows-and-grids.md) | Virtualized rows and grids: TanStack Virtual, roving focus by index, WebKit's image cache | 2026-10-29 |
| [0026](0026-home.md) | Home: a fixed hero from the first catalog, rows in the layout's order, and one seam for playback | 2026-10-29 |
| [0027](0027-browse-pages.md) | Browse pages: one catalog at a time, filters from its own extras, anime by type and addon | 2026-10-29 |
| [0028](0028-search.md) | Search: every search catalog at once, merged in addon order as each answers | 2026-10-29 |
| [0029](0029-title-page.md) | Title page: details from the first addon that has them, watched state as Nuvio's apps keep it | 2026-10-29 |
| [0030](0030-library-page.md) | Library page: the whole library from the local store, sorted and filtered in the page | 2026-10-29 |
| [0031](0031-optional-tmdb-key.md) | An optional TMDB key: the user's own, in the keychain, adding art over the addon's | 2026-10-30 |
| [0032](0032-upcoming-episodes.md) | Upcoming episodes: a Library tab built from each show's details | 2026-10-30 |
| [0033](0033-collection-folders.md) | Collection folders: a folder's catalogs taken in turn, in one grid that only grows | 2026-10-30 |
| [0034](0034-parallel-stream-requests.md) | Streams: every stream addon at once, each with its own state, fed on in slices | 2026-10-30 |
| [0035](0035-stream-ranking-engine.md) | Stream ranking: our own parser and ranker, in a Web Worker, fed slice by slice | 2026-10-30 |
| [0036](0036-stream-picker.md) | The stream picker: one highlighted top pick played with P, groups by quality, badges instead of file names | 2026-10-30 |
| [0037](0037-resolving-streams.md) | Resolving a picked stream: one ranged request through Go, the pick and then its copies, notices read by name | 2026-10-30 |
| [0038](0038-debrid-keys-stay-with-addons.md) | Debrid keys stay with the addons: Sinag holds no debrid account of its own | 2026-10-30 |
| [0039](0039-player-service.md) | The player service: one mpv session per playback, three events, a host per OS; progress reported from Go, resume from the store (#64); skip intro and credits from chapters or IntroDB (#69); mini player (#70) | 2026-10-30 |
| [0040](0040-torrent-streaming.md) | Torrent streaming: anacrolix/torrent in-process, a loopback link for mpv, our own capped cache, off until turned on | 2026-10-30 |
| [0041](0041-our-libmpv-build.md) | Our libmpv build: one self-contained library per target, every decoder kept, built and cached in CI | 2026-10-31 |

0001–0005 came out of the M0 gate review ([`../m0-gate-review.md`](../m0-gate-review.md), #8).
