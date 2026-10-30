---
name: stream-requests
description: "How Sinag asks stream addons (#50): useStreamAddons (enabled, not visible), useStreams per-addon state, StreamFeed 150-stream slices, /streams picker route that usePlay opens; read before #51, #52, #53, #58, #60"
metadata:
  type: project
---

Streams (#50, ADR-0034) are `frontend/src/lib/streams.ts`: `useStreamAddons(profileId)` (enabled addons, **not** VisibleAddons; each usable as soon as its own manifest loads, `loading` until all have), `useStreams(addons, type, id)` → `StreamSource[]` (status, streams, AddonError, `retry`), `StreamFeed`/`useStreamFeed` (each addon's answer once, arrival order, `sliceSize` 150). The provisional picker is `components/streams/streams-page.tsx` on `/streams/$type/$id?video=&at=`, `PlayTarget` in `HistoryState.play`.

**Why:** the ticket asks for progressive per-addon results, timeouts and cancel-on-leave; ranking (#51) and the real picker UI (#52) are separate tickets, so the picker lists streams unranked in arrival order.

**How to apply:**
- #51 is done: the picker ranks through `useRankedStreams` (see [[stream-ranking]]). #52 is done: the list is [[stream-picker]]; the per-addon pills and the summary stayed.
- `usePlay()` now navigates to the picker; a series without `videoId` goes to its title page. Picking a stream still toasts "Can’t play … yet" until #60.
- Cancellation relies on unmount: the picker must not keep a stream query observed elsewhere.
- Tests: `routes/streams.test.tsx` `serve()` races each answer against the request's abort signal and returns `{url, signal}` per call, so tests can assert aborts.
- Related: [[addon-protocol-client]], [[title-page]], [[home-page]], [[kids-profiles]].
