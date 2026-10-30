---
status: accepted
date: 2026-10-30
---

# The stream picker: one highlighted top pick played with P, groups by quality, badges instead of file names

#52 builds the picker's design (story 2: pick the best stream and press play without reading file names) on the ranked view from #51 ([ADR-0035](0035-stream-ranking-engine.md)). It keeps #50's per-addon pills and summary ([ADR-0034](0034-parallel-stream-requests.md)) and replaces the provisional list.

## Layout

| File | |
|---|---|
| `components/streams/stream-list.tsx` | `listRows(view, open)` and `StreamList`: the top pick, group headings and stream rows in one virtualized list |
| `components/streams/streams-page.tsx` | The page: heading, summary, addon pills, the list, the P key |
| `lib/stream-labels.ts` | Pure labels for the badges, from `Candidate.parsed` |
| `components/gallery/stream-sample.tsx` | Gallery › Stream picker: every kind of stream, from made-up answers |

## The top pick

The engine's `view.top` (the best stream outside the collapsed groups) is the first row: a card with the brand border, "Top pick", larger badges and a Play pill showing **P**. **P plays it from anywhere on the picker** (not while typing, not with a modifier), so launch → Play → P stays within #40's three steps. Enter on the focused card plays it too. The top pick leaves its own group so it's listed once.

Focus doesn't move to the list when it opens: focusing pins the top pick (`pin()`), and pinning before the user does anything would freeze whatever answered first. The pin happens on the first focus or pointer-down in the list, and on play.

## Groups and badges

Headings in tier order: 4K · 1080p · 720p · SD · Unknown, then **Low quality (CAM / TS)** and **Likely fake**, each collapsed behind its own heading button (`aria-expanded`) with a one-line note on why. Each heading shows its count.

Each row has two lines:

- **Badges:** resolution ("4K", "1080p"; "Unknown quality"), HDR10 / HDR10+ / Dolby Vision, audio ("TrueHD 7.1", "DD+ 5.1"), Atmos, source ("Remux", "Blu-ray", "WEB-DL").
- **Details** in Geist Mono: how it plays (**Cached · TorBox** in the brand colour with a bolt; **Not cached · TorBox**; **P2P · 58 seeders**), size in decimal units, up to three audio languages, the addon, "2 more copies" when it has alternates, and, for a stream that isn't `ok`, why (warning colour): "Another year's release", "Larger than its source allows". A title mismatch says nothing, as it moves nothing until #99.

## File names on demand

Each row has a **File name** button (or **I** on the row) that opens the parsed names under it: the file as the addon sent it, its folders, then the release names. Never the URL, which can carry a debrid key; the route tests check `KEY` isn't in the page with names open.

## Keyboard

The list is one Tab stop (the active row, by key since rows move as answers arrive; the first mounted row when that one scrolls away). ↑ / ↓ move between rows and collapsible headings, Home / End jump to the ends, Enter plays or opens a group, I toggles the file name, P plays the top pick. The File name button shares the row's Tab stop and keys. The gallery's focus-ring audit covers the new controls.

## Alternates

A candidate's `alternates` are other copies of the same file. The picker says how many, and passes the candidate on pick; #53 tries `candidate.stream`, then each alternate in order, if one fails to resolve.

## Still to come

Picking a stream still says the player isn't built (#60). The resolution cap, HDR / DV and language-order settings are #98.
