---
name: upcoming-episodes
description: "How Peli's Upcoming calendar (#48) works: Library tab ?view=upcoming, lib/calendar.ts rules, cachedTitleMeta, same-day grouping, test helpers; read before notifications or a Home 'coming up' row"
metadata:
  type: project
---

The calendar (#48, ADR-0032) is the Library page's **Upcoming** tab (`components/library/upcoming.tsx`, `/library?view=upcoming`). It isn't a top-level section, because of the six-item nav cap. The rules are in `lib/calendar.ts`: `calendarShows` (everything but films), `calendar(shows, now)` → `{ days, later }` (from local today, 28 days by day, then each show's next episode), `entryCode`, `dayLabel` → `{ title, date? }`.

**Why:** Cinemeta's `calendar-videos` catalog answers `metasDetailed` and only covers IMDb ids, so each show's details come from `titleMetaQuery` instead, which also covers Kitsu and the persisted cache.

**How to apply:**
- Seed any `titleMetaQuery` with `...cachedTitleMeta(client, addons, type, id)`. It passes `initialDataUpdatedAt`, so stale details still refresh. The title page uses it too.
- `useOpenTitle()(preview, { season })` opens a title on a season.
- `CalendarEntry.episodes` holds a show's episodes on one day. `episode` is the first.
- Cinemeta lists real upcoming episodes, with "TBA" titles for unnamed ones, so a live check needs shows that are airing now (find them by scanning Cinemeta's `series/top` metas for future `released`).
- Tests: `routes/library.test.tsx` builds metas dated relative to today (`day(n)` = local noon). Seeding the cache needs `parseManifest`/`parseMetaResponse`, not raw fixtures. Title paths come back URL-encoded (`kitsu%3A…`).
- Adding coss `tabs` also pulls in `segmented-control.tsx`. Its CSS-variable style needed a typed const for lint.
- **Calendar layout** (2026-11-24): `?layout=calendar` (`LibrarySearch.layout`) swaps the list for `upcoming-calendar.tsx`, a month `<table>` (no `role="grid"`: jsx-a11y refuses it on a table; the chosen day is `aria-pressed`) with a day panel of `EpisodeEntry` rows (`episode-entry.tsx`, shared with the list). Logic in `lib/calendar.ts`: `monthGrid`, `scheduleByDay` (past days included), `firstWeekday`, `monthLabel`, `shiftMonth`. `dayLabel` now dates past days, so short past captions (Home's New episodes) use `recentDayLabel`.
- Related: [[library-page]], [[title-page]], [[kids-profiles]].
