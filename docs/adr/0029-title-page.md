---
status: accepted
date: 2026-10-29
---

# Title page: details from the first addon that has them, watched state as Nuvio's apps keep it

#45 builds the title page (F11): a title's art, details and cast, Play or Resume, Add to library, and for a series its seasons and episodes, with watched marks and progress. It lives on `/title/$type/$id` (`components/title/`), with the rules in `lib/title.ts`. The acceptance is that watched state and progress match Nuvio mobile, so the rules below are taken from its source (`NuvioMedia/NuvioMobile`, `WatchingActions.kt`, `WatchedRepository.kt`, `WatchProgressModels.kt`, at `53869a0`).

## Opening a title

- **Address:** `/title/<type>/<id>`, with the season shown as `?season=`, written with `replace`. Kitsu types its anime `series` or `movie`, so a title opens by its item's own type and id, and its details come from Kitsu.
- **What opens it:** poster cards on Home's catalog rows and library row, the browse grids and Search, plus a **Details** button on Home's hero. Continue Watching still resumes. Collection folders are #96.
- **Painting at once:** the card passes its name, art, year and synopsis in history state (`HistoryState.title`), so the hero paints before the details answer. A title seen before paints its full details from the persisted `metaQuery` cache.
- **Back:** a Back button on the page goes back in history, or to Home when there's nowhere to go back to.

## Where the details come from

`titleMetaQuery` asks the profile's visible addons (`VisibleAddons`, so a kids profile stays inside its allow-list) that serve `meta` for the type and id, in the user's order (`addonsFor`, ADR-0023). It asks one at a time and moves on when one fails, so the first addon that answers wins. The per-addon request isn't retried, because moving to the next addon is the retry. When none answers, the page says so and offers a retry, keeping the card's preview on screen.

## Watched rules (Nuvio's)

| Rule | Nuvio | Sinag |
|---|---|---|
| A film or episode is watched | It has a watched mark, or its progress is ≥ 90 % (`WatchProgressCompletionPercentThreshold`) | `titleState().watched` |
| Progress shows | Under 90 % | A progress bar on the episode, or Resume |
| A series is watched | Every released episode of seasons 1 and up is watched; Specials and unaired episodes don't count | `seriesWatched` |
| Marking or unmarking | Writes or removes the marks and **clears the progress** of each item | `SetWatched` clears progress either way |
| Series-level mark | Kept in step with the episodes (`reconcileSeriesWatchedState`) | After each edit on this page |
| Mark the whole series | The series mark plus every released main episode | The hero's Mark watched |
| Episode menu | Mark watched/unwatched; mark earlier episodes watched/unwatched | The same |
| Season | Mark the season's released episodes watched/unwatched | The button by the season picker |

One difference: Nuvio also reconciles the series-level mark when a title page just opens. Sinag only does it after an edit on the page, so viewing a title never writes. The page computes "watched" from the episodes either way, so what it shows is the same.

## One write for many marks

Marking a season, or a series of a thousand episodes, through `MarkWatched` would be one bridge call and one bbolt transaction each. `Store.SetWatched(profile, items, watched)` writes them all in one transaction, clears each item's progress, and queues a push per change. An item already marked keeps its mark and time and queues nothing. Pushes go out through the outbox as usual (ADR-0017).

## Play

Everything goes through `usePlay()` (ADR-0026). The stream picker (#52) and the player (#60, #64) will fill it in; until then it shows a toast.

- **Film:** Resume from its progress, or Play.
- **Series:** Resume the most recently watched episode still under 90 %. Otherwise play the episode after the furthest one watched ("Play S2 · E4"), and after the last episode start again from S1 · E1. Specials only play when picked.
- **Episode row:** plays that episode, resuming if it has progress. Unaired episodes are dimmed with their air date and can't be played or marked.

## Layout

- **Hero:** the shared `Hero`, which now takes a `logo` and falls back to the name if the logo fails to load. Below it, a meta line (year · runtime · up to three genres · IMDb rating), the synopsis, then Play/Resume, Add to library / In library, and Mark watched / Watched.
- **Episodes:** season chips, or a select past eight seasons, with Specials last. The page opens on the season Play would play from. Each row shows the episode's still, ✓ when watched, a progress bar, its number, air date and runtime, title and synopsis. The list is virtualized and scrolls with the page, since Kitsu can list a thousand episodes in one season. ↑ and ↓ move between rows.
- **About:** the full synopsis, then cast, directors, writers, genres, country and awards, as the addon names them. Cast photos and other ratings need TMDB (#47).

## Library

Add to library saves a `LibraryItem` from the details: name, art, synopsis, year, IMDb rating, genres, and the base URL of the addon the details came from, as Nuvio's apps record it. It syncs like any library edit.

## Verification

- **Go:** `TestSetWatched` covers one transaction, already-marked items kept, progress cleared, and the pushes queued.
- **Unit tests** (`lib/title.test.ts`) cover episode order, what counts for the series, the 90 % rule, the series-mark change, Play's choice, and the library item.
- **Route tests** (`routes/title.test.tsx`) cover:
  - opening from a card and painting from it before the details;
  - Back;
  - falling back to the next addon, and never asking one a kids profile can't see;
  - the failure notice;
  - a film's watched and library toggles;
  - episodes' marks, progress and Resume;
  - season and episode-menu marks with the series mark kept in step;
  - the season in the address, unaired episodes, and Kitsu's anime.
- **Live check:** with stubbed bindings in Playwright's WebKit, Breaking Bad, The Shawshank Redemption and Frieren opened from Search against live Cinemeta and Kitsu. The card painted the hero 55–65 ms after the click, and the details filled in 0.1–0.9 s after it. Marking Season 2 ticked every episode, and Back returned to the same search.
