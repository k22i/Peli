---
status: accepted
date: 2026-10-30
---

# Streams: every stream addon at once, each with its own state, fed on in slices

#50 asks every stream addon for a film or episode in parallel and shows the results as they arrive (F14). The rules are in `frontend/src/lib/streams.ts`. A provisional picker on `/streams/$type/$id` (`components/streams/streams-page.tsx`) shows them until the ranking engine (#51) and the ranked picker (#52) land.

## Which addons

Every **enabled** addon whose manifest loaded, in the user's order, routed with `addonsFor(addons, "stream", type, id)` (ADR-0023). The id is the episode's video id (`tt0903747:1:2`) or the film's own.

- **Not `VisibleAddons`.** Streams aren't limited for a kids profile: the title already came from a catalog it may see (ADR-0014). A route test checks that a stream addon the kids profile doesn't browse is still asked, and a disabled one isn't.
- **No waiting on slow manifests.** Each addon is asked as soon as its own manifest loads. The summary says "still loading addons" until every manifest has answered, so it never claims to be done while an addon may still join. An addon whose manifest fails drops out, as on every other surface.

## Requests

- **One `streamsQuery` per addon**, all at once. A slow addon holds back only itself.
- **Timeouts** are the client's: 30 s for streams, since Comet took up to 18 s (#6, ADR-0023).
- **Not retried** automatically, so a dead addon shows its error instead of doubling its wait. Each addon has its own **Try again**, which asks only that addon.
- **In memory only**, for 5 minutes: debrid links embed the user's key and expire.
- **Cancelled on leaving.** The queries pass TanStack Query's signal to the client. When the picker unmounts and nothing else observes a query still in flight, TanStack Query aborts it, and the client aborts the fetch. A route test checks that every request's signal is aborted after Back.

## Per-addon state

`useStreams` returns a `StreamSource` per addon, in addon order: `pending`, `success` with its streams, or `error` with the `AddonError`, whose message is for the user and never names the URL ("The addon didn't answer.", "The addon answered 503."). The picker shows each as a pill (spinner, count, or reason plus Try again) and a live summary ("98 streams, 1 of 2 addons still answering").

## Feeding the ranking engine

Comet alone can send ~1,400 streams for a popular title. `StreamFeed` hands each addon's answer on **once**, in the order answers arrive, cut into slices of at most 150 (`sliceSize`), the size #6 measured as fitting in a frame. A refetch of an addon already fed is skipped; an addon that failed is fed once a retry answers. `useStreamFeed(sources, onSlice)` runs it after each render. One feed lives per mount, so the picker is keyed by video.

For now, the picker's list is built from that feed: streams are appended in arrival order, so nothing already shown moves. The list is virtualized, since one addon can send over a thousand. #51 will take the same slices (in a Web Worker), and #52 will replace the list with ranked groups.

## Playback entry

`usePlay()` (ADR-0026) now opens the picker instead of a toast: `/streams/$type/$id?video=…&at=…`, with the `PlayTarget` in history state for the heading. A series with no episode chosen (Home's hero on a show not yet started) opens its title page instead. Picking a stream still says the player isn't built (#60).

## Never logged

Stream URLs embed the user's debrid key. Nothing here logs them, and the picker shows each stream's `name` and `description`, never its `url`. A route test checks that the key in a stream's URL isn't in the page.

## Checked

Unit tests for `slices` and `StreamFeed`, and route tests for opening from Play (film and episode), progressive answers, failure and retry, cancellation on Back, a 1,400-stream answer that mounts fewer than 50 rows, kids profiles, no stream addon, and picking. Against the live Torrentio and Peerflix in headless Chrome with stubbed bindings: Torrentio's 98 streams for The Shawshank Redemption showed about 0.6 s after Play, Peerflix's 15 about 1.2 s.
