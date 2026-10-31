---
name: tracking-integrations
description: "Epic #71 as built (ADR-0042): internal/simkl, internal/anilist, internal/animelist, internal/tracking; client ids, live-test harness and gotchas"
metadata:
  type: project
---

Epic #71 tracks with SIMKL (#72–#74) and AniList (#104/#105); Trakt replaced and Discord dropped (#75 closed) on 2026-10-31. Built the same day (ADR-0042): `internal/simkl` (AUTH V2 device flow, scrobble, history, activities/all-items; fake in `simkltest`), `internal/anilist` (GraphQL), `internal/animelist` (Fribb anime-list-mini.json downloaded weekly into the data dir), `internal/tracking` (Wails service + scrobbler fed by `player.ReportTo` alongside `watching`). Frontend: `lib/tracking.ts`, `components/settings/tracking-dialogs.tsx`, Settings › Integrations rows.

**Why:** the user's choice of trackers. SIMKL stop uses `min_progress=90` so it agrees with Nuvio's 90 % ([[title-page]]).

**How to apply:**
- Client ids (public) are constants in `internal/tracking/tracking.go`: SIMKL app is the "TV, devices & command line" kind; AniList app 55505 with redirect `http://127.0.0.1:47613/anilist`. Paste the AniList *ID*, never its secret.
- Tokens per profile in the keychain (`simkl.access-token.<id>` etc.); kids profiles refused ([[kids-profiles]]).
- Player reports now include `started`/`resumed` (watching doesn't push on them).
- Live check that worked: a temporary `devtrack.go` hook in package main (never commit) that calls StartSimkl/WaitSimkl, plays a 2-minute ffmpeg clip as a film through `players.Load`, checks `/sync/all-items`, removes it with `/sync/history/remove`, then the same for AniList (`DeleteMediaListEntry`). The user only clicks Allow/Approve in the browser. Pick a title not already on their list (Frieren was on AniList).
- Related: [[spike-ticket-workflow]], [[live-tests-push-to-nuvio]].
