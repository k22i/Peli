---
status: accepted
date: 2026-10-27
---

# Offline and reconnect: learn the connection from the sync traffic, probe only while offline

The app opens and works with no network, and what changed offline syncs once it is back (#31, NFR Offline). The launch path was already local; this ADR covers how the app knows it's offline, what it shows, and what it does when the network returns.

## The launch path stays local

Nothing between launch and Home waits on the network. The root gate reads profiles, the account status (keychain and store, ADR-0009) and the current profile from Go, and Home reads Continue Watching and the library from the store (`libraryQuery`, `continueWatchingQuery` in `lib/library.ts`, under the surfaces' query keys so a pull refreshes them, and under the profile ID so a switch loads the new one). They aren't put in the persisted query cache: the store is already on disk and answers in milliseconds (#14). The launch pull runs in a goroutine (ADR-0016). Until #42 brings addon metadata, a Continue Watching entry takes its name and art from the library, or shows its content ID.

## Knowing the connection

`syncer.Monitor` keeps one of three states, starting at **online** so a launch with the network up shows nothing while the first pull is on its way:

| Learnt from | State |
|---|---|
| `nuvio.ErrUnreachable` (no network, DNS, timeout) | **offline** |
| `nuvio.ErrUnavailable` (5xx) | **unavailable** ("Nuvio is down") |
| any other answer, success or not (429, 4xx) | **online**: Nuvio answered |
| signed out, cancelled | no change: a missing session is known without asking |

It learns from **every pull and push the app makes anyway** (`observe`, wired into `Puller` and `Pusher`), so there are no extra requests while online. Only requests for profiles linked to Nuvio count, so the Guest, which makes none, never shows the indicator (#23).

**While offline, and only then,** it probes: `GET /.well-known/nuvio`, which needs no session and writes nothing (`nuvio.Client.Ping`), from 5 s doubling to 1 min. Window focus pulls and pushes as before (ADR-0016/0017), so coming back to the window is a check too, and the webview's `online` event asks Go to check at once (`Service.CheckConnection`). **Unavailable isn't probed**: the discovery document may well answer while the database doesn't, and the 5-minute poll and the push backoff are kinder to a struggling backend than a probe every few seconds. A pull or push that gets through ends it.

We chose this over OS network-change notifications (three different APIs, and "a network is up" isn't "Nuvio is reachable") and over the webview's `navigator.onLine` alone (it only knows about interfaces; it's used as a hint to check sooner).

## Reconnecting

When the state turns online from anything else, `Service.reconnect` runs once: **the outbox first** (`Pusher.Resume`: forgets the backoff, keeps the 30 s progress interval and the watched grace), **then the pull** (`Puller.PullNow`, ignoring the 30 s throttle, since what was pulled before the network went may be the last thing that got through). Pushing first means the pull's echo is of the user's offline changes, which `ApplyChanges` already settles (ADR-0015). Resume resets the backoff under the flush lock, so a push that failed just before the network returned can't put it back. Shutdown waits for a reconnect still running.

## The indicator

A row above the profile menu in the sidebar (every OS has a sidebar; Linux has no title bar): a cloud-off icon and "Offline" or "Nuvio is down", with a tooltip saying the app shows what's saved here and syncs later. Clicking it checks again. It's an `<output>`, so screen readers hear it appear, and it blocks nothing. `sync:connection` carries changes to the frontend (`useConnectionEvents`, mounted at the root).

## What we give up

- **A short window of "online" while offline at launch:** until the launch pull fails, a second or so (or the client's 15 s timeout on a network that drops packets).
- **Offline for under a minute may take up to a minute to notice it's back,** unless the user focuses the window or the OS fires `online`.
- **Changes that can't wait for the network still can't**: profile edits are refused offline (ADR-0012), and an offline sign-out loses what's queued (ADR-0017).

## Revisit if

Nuvio offers a health endpoint, a realtime channel appears (it would tell us the connection for free), or #34's custom servers need the indicator to name which backend is down.
