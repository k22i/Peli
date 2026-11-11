---
name: tracking-ui
description: "Tracking UI on top of tracking-actions: TrackingMenu in the title menu extras slot, title-page Watchlist + Rate round actions, Library ?view=watchlist, useTrackingControls, test gotchas"
metadata:
  type: project
---

UI for [[tracking-actions]] (SIMKL/AniList status, rating, watchlist). Everything is hidden on kids profiles and with nothing connected.

**Layout**
- `lib/tracking.ts`: `useTrackingControls(profile, type, ref)` → `{available, statuses, state, setStatus, setRating}` (`available` = a non-kids profile with a usable connection; the title's state is only fetched then). The mutations toast `trackingActionProblem` on failure and roll back; `setStatus` also takes the title off the cached watchlist unless the status is `planned`. `ratingValues`, `trackingStatusOf`.
- `components/media/tracking-menu.tsx` (`TrackingMenu`), rendered by `TitleMenuExtras` (the slot from [[title-menus]]): own separator, then Add to / Remove from Watchlist (planned ↔ none), a Status submenu (radio items: only the statuses the connected services keep, minus planned; "None" = off the lists), Rate… submenu (radio 1–10, Clear rating when rated).
- `components/title/tracking-actions.tsx` (`TrackingActions`) in the hero actions after Watched: Watchlist `RoundAction` ("Add to watchlist"/"On watchlist") and a Rate round button (coss `Menu` inside a `Tooltip`; label "Rate"/"Your rating: N"). `RoundAction` moved to `components/title/round-action.tsx`.
- `components/library/watchlist.tsx`: Library `?view=watchlist` (`LibrarySearch.view` accepts it; `librarySearch` keeps it). States: skeleton, not connected (LibraryNotice + link to `/settings?section=tracking`), error with Try again, empty, PosterGrid of `PosterCard`s with the shared menu (`menuTitle`, imdb from `ids`). The tab is shown on every non-kids profile, connected or not, so the not-connected state is reachable; a kids profile with that URL falls back to Titles.

**Gotchas**
- `test/setup.ts` now mocks `@bindings/tracking` globally (nothing connected; Status/ImportSoon/TitleStatus/Watchlist). Tests that need more mock it again in the file (settings.test.tsx and tracking-ui.test.tsx do).
- In jsdom here, `user.click` doesn't register on Base UI **tabs** (the Upcoming tab test fails the same way on main) nor reliably on submenu radio/items: use `fireEvent.click` there, `userEvent.setup({ pointerEventsCheck: 0 })`, and open a view by its address. Radio items leave the menu open: press Escape twice (submenu, then menu) before opening another, or the cards stay aria-hidden.
- The title's tracking query key is `["tracking", profileId, "title", type, id]` with type normalised to movie/series, so the menu and the page share one entry.
- Baseline at build: `pnpm check` has the 9 ProfileSettings fixture errors; `pnpm test` ~45 failures in plugins-pane, ranking, router, browse, gallery, library (Upcoming tab), player, profiles, search, settings (4), streams — none from this work.
- Not checked in a real window (jsdom only); no screenshots.
