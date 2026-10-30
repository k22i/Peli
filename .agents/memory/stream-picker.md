---
name: stream-picker
description: "The ranked stream picker (#52): stream-list.tsx rows + roving keys, P plays the top pick, stream-labels.ts badges, file name on demand, no autofocus (it pins); read before #53, #58, #60, #68"
metadata:
  type: project
---

The picker's design (#52, ADR-0036): `components/streams/stream-list.tsx` (`listRows(view, open)` → top / group / stream rows in one virtualized list; `StreamList` with roving focus by row key), `streams-page.tsx` (P key via `usePlayKey`, per-tier `open` set, `pick(candidate)` toasts until #60), badge text in `lib/stream-labels.ts` (pure, tested), Gallery › Stream picker in `components/gallery/stream-sample.tsx`.

**Why:** the ticket asks for a one-key play, quality groups with badges, file names on demand and full keyboard use; focusing pins the top pick, so the list is never autofocused.

**How to apply:**
- #53: `pick` gets the whole `Candidate`; try `candidate.stream`, then `candidate.alternates` in order. Replace the toast in `streams-page.tsx`.
- Route tests: `shownStreams()` filters out buttons with `aria-expanded` (group headings, File name); group headings are named like "Likely fake 8"; the top pick's text starts "Top pick".
- Screenshot harness: copy `stubs/` + `shot2.mjs` pattern (hash URLs `#/title/...`, throwaway `vite.stub.config.ts` in frontend/ aliasing `@bindings/*`, port 9311); the picker then asks live Torrentio/Peerflix.
- Related: [[stream-ranking]], [[stream-requests]], [[sinag-design-direction]].
