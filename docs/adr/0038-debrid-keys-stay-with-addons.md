---
status: accepted
date: 2026-10-30
---

# Debrid keys stay with the addons: Sinag holds no debrid account of its own

#54 planned debrid accounts in Sinag itself: connect and disconnect TorBox, AllDebrid and Premiumize in Settings, keep each token in the keychain (ADR-0007), and use it for link resolution or cache checks. Its open question was whether that work shrinks to a status display if addons do all the debrid work. They do. **Sinag stores no debrid key**, and Settings › Integrations › Debrid services points the user to their stream addons instead.

## Every flow, and who needs the key

| Flow | Who does it | Sinag needs the key? |
|---|---|---|
| Finding streams on the user's service | The addon (Torrentio, Comet, MediaFusion, AIOStreams, Peerflix), configured with the user's key in its URL | No |
| Knowing whether a stream is cached | The addon, as a marker in the stream's `name` (`[TB+]`, `[TB⚡]`, …), read by `parseStream` (ADR-0035) | No |
| Resolving a pick to a file | The addon's resolve URL, which redirects to the service's CDN. Sinag follows it (ADR-0037) | No |
| A bad key, an ended plan, a file not cached yet | The addon's notice video, which Sinag reads as `denied`, `caching`, … and explains, naming the service | No |
| Torrents with no debrid | The torrent engine (#55) | No |
| Account status (plan, days left) | Only the service's own API | Yes |

Only the last row needs a key, and it isn't worth one. The user would paste the same key twice, once into the addon and once into Sinag, and the two could drift apart: a status that says "connected" while the addon has an old key is worse than none. When the plan or the key is the problem, resolving already says so ("TorBox refused the stream · Check the debrid key in the addon's settings and that your plan is active").

Every addon recorded for #6, #50 and #53 does all of this itself, and addons that bundle several services behind one config (AIOStreams, MediaFusion) only make that more common.

## What changes

- **Settings.** The "Debrid services" row in Integrations said "Coming soon". It now says to set up TorBox, AllDebrid or Premiumize in a stream addon's own settings, and that Sinag never asks for the key. Its button opens the addon manager. The addon's configure page is where the key goes (ADR-0024).
- **Secrets.** `debrid.*` is no longer a key the webview can name (`lib/secrets.ts`). The Go secrets service still accepts any well-formed key, and its tests use `debrid.torbox` only as a sample name.
- **ADR-0007** listed debrid keys among what the keychain holds. That part no longer applies; the Nuvio session, Trakt tokens and the TMDB key still do.

Nothing else changes: debrid keys still pass through Sinag inside addon URLs and stream links, so they are still never logged or shown (ADR-0023, ADR-0024, ADR-0037).

## Not shown: which services are set up

A status line naming the user's services ("TorBox, through Torrentio") was considered. The only place an addon says which service it uses before it's asked for streams is its config, in the URL path, which Sinag deliberately doesn't read because it holds the key (the addon manager shows only the host, ADR-0024). Each addon writes it differently, and some, like AIOStreams, keep it opaque. The cache markers in a title's streams do say, but only after a picker has asked the addons, and streams aren't persisted (ADR-0023). The picker already shows the service on each stream's badge, which is where it matters.

## Revisit when

- An addon we recommend stops resolving debrid itself and expects the client to hold the key.
- We want Sinag to check debrid caches for streams that carry only an info hash (Peerflix without a service, torrent-only addons), or to send a torrent to the user's service. Both need the service's API and the key. The token would then go in the keychain as `debrid.<service>`, as ADR-0007 planned.
- #101 decides to resolve a cached top pick early and wants to remove what that adds to the user's debrid list.

Checking AllDebrid's and Premiumize's cache markers against recorded answers is #97. It needs test accounts on those services, not a feature in Sinag.
