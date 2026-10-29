---
status: accepted
date: 2026-10-30
---

# Upcoming episodes: a Library tab built from each show's details

#48 adds a calendar of upcoming episodes for the shows in the library (F13, P2). The navigation is capped at six items (epic #9), so the calendar is an **Upcoming** tab inside Library, not a new top-level section. The view is `components/library/upcoming.tsx` on `/library?view=upcoming`, and its rules are in `lib/calendar.ts`.

## Where the episodes come from

Each library title that isn't a film gets its details through `titleMetaQuery`, the title page's query (ADR-0029). It asks the profile's visible addons in the user's order, so Kitsu anime work as well as Cinemeta shows, and a kids profile stays inside its allow-list. Each answer lands in the persisted `metaQuery` cache. `cachedTitleMeta` (`lib/title.ts`) seeds the query from that cache along with when the answer came, so a show seen before paints at once and offline, and a stale answer still refreshes. The title page now uses the same helper. Shows fill in as their addons answer, with a "Checking your shows" line until the last one has answered. Shows that failed are counted, with a Try again button.

**Rejected:** Cinemeta's `calendar-videos` catalog. It takes up to 100 IMDb ids in one request, but it answers with `metasDetailed` rather than `metas`, it only covers IMDb ids (not Kitsu), and its answer is cached apart from the title page's details.

## What's listed

- **From the start of today**, as the viewer's local day, the same as the title page's air dates. Episodes with no date, or a date that can't be read, aren't listed. Specials (season 0) are left out, as Nuvio's apps leave them out of a series' count.
- **Every episode for the next 28 days**, by day. A show's episodes on the same day share one row ("S3 · E1–E4 · 4 episodes"), so a season dropped at once doesn't fill the day. Within a day, rows go by air time, then by name.
- **Later:** after 28 days, only the next episode of each show not already listed, soonest first, with its date. A show that lists a whole season months ahead adds one row, not a dozen.
- **Headings:** Today, Tomorrow and the weekday within the week show the date beside them ("Today · Oct 30"). Past that the heading is the date itself, with the year when it isn't this year.

A row shows the show's poster and name, the episode code and the episode's title. Opening a row goes to the show's page on that season (`useOpenTitle` now takes a `season`), painting from the library card. Unaired episodes can't be played, so rows don't offer Play.

## The tab

coss `tabs` (Titles · Upcoming) sit beside the page title. The view is kept in the address, written with `replace` like the filters. The Titles tab's type and sort stay in the address, so switching back restores them. The sidebar's Library link stays active, since the path doesn't change.

## Not here

- **Notifications** for new episodes, and a Home row. Either can build on `calendar()` later.
- **A month grid.** Rows grouped by day suit a list of a few dozen episodes better, and keep the poster and title readable.

## Verification

- **Unit tests** (`lib/calendar.test.ts`) cover:
  - which titles count;
  - order by day and time;
  - Specials, missing dates and broken dates;
  - the 28-day cut-off and Later;
  - same-day episodes sharing a row;
  - the day headings.
- **Route tests** (`routes/library.test.tsx`) cover the tab and the address, Later, grouping, opening on a season, painting from the cache with no fetch, failures with Try again, nothing coming up, and a library with no shows.
- **Live check:** Playwright's WebKit with stubbed bindings and live Cinemeta and Kitsu answers, on a library of 10 shows plus a film and Frieren, in dark and light. The first row painted 1.6 s after opening the tab cold, and 0.3–0.4 s from cache. Rings of Power's four-episode drop showed as one row. The Rookie and Silo went under Later. Opening a Later row went to the show on its season, and Back returned to the tab.
