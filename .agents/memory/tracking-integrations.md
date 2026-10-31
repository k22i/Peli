---
name: tracking-integrations
description: Epic #71 tracks with SIMKL (#72–#74) and AniList (#104/#105); Trakt replaced, Discord dropped (#75 closed)
metadata:
  type: project
---

On 2026-10-31 the user replaced Trakt with SIMKL and dropped Discord rich presence from epic #71. SIMKL lane: #72 sign-in + per-profile settings (scrobble, history import, anime), then #73 scrobbling and #74 history sync. AniList lane: #104 sign-in, then #105 progress sync. #75 (Discord) is closed as not planned.

**Why:** the user's choice of trackers; no reason given beyond that.

**How to apply:** don't plan or build Trakt or Discord work. Code still names Trakt in places (Settings "Coming soon" row, `trakt.*` keys in `frontend/src/lib/secrets.ts`, README, ADR-0007); #72 replaces them. Open question in #73: SIMKL marks watched at 80 %, Nuvio at 90 % ([[title-page]]). Kids profiles get no connection ([[kids-profiles]]).
