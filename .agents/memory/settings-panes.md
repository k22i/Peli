---
name: settings-panes
description: "#120 Settings as panes: panes.ts (ids, ?section=, last pane), SettingsPaneList/Rail/Group/Row, one pane per component, tracking lead, tests open a pane first"
metadata:
  type: project
---

#120 (redesign epic [[redesign-epic]]) turned Settings into nine panes (account, content, playback, languages, streaming, tracking, appearance, privacy, about). `components/settings/panes.ts` holds `settingsPanes` (id, title, lucide icon), `paneFromSearch` (the route's `validateSearch`: unknown/missing → no `section`, so Account) and the module-level `lastOpenPane()`/`rememberPane()` that Ctrl/⌘+, in `app-shell.tsx` reads (a variable, not storage). `settings-section.tsx` has `SettingsPaneList` (md+, `nav` "Settings panes", links to `?section=`, `replace`, roving tab stop on the current pane, `moveFocus` copied from the sidebar, `onNavigate(viaKeyboard)`), `SettingsPaneRail` (below md, `ChipRail` as a `group` "Settings panes"), `SettingsPaneView` (h2 `#settings-pane-title`, `tabIndex -1`, optional lead), `SettingsGroup` (optional h3 title, `rounded-2xl` list, footer) and `SettingRow` (same id/-label/-description contract). `routes/settings.tsx` has one component per pane; `WithSettings` shows a skeleton until profile + device settings load.

**Why:** the user wanted System Settings-style panes so each is short; rows moved unchanged.

**How to apply:**
- Add a setting to the pane it belongs to; a new pane needs an entry in `settingsPanes` and a case in `Pane`.
- The current item's background is its own `span[data-settings-pill]` so #124 can make one sliding pill. Link's own `aria-current` only turns on when its search matches, so the item sets `aria-current`/`data-status` itself (Account is current with no `?section=`).
- The heading takes focus after a pane change only when the click had `detail === 0` (Enter); a new pane also scrolls `#content` to the top.
- Tracking: the old "SIMKL and AniList" row is the pane's lead (kids: "Kids profiles don’t connect to trackers." and no groups).
- Both the list and the rail are in the DOM; CSS hides one (`max-md:hidden` / `md:hidden`), jsdom shows both, so tests query inside `navigation`/`group` "Settings panes".
- Tests: `renderSettings(section)` in `settings.test.tsx` opens `/settings?section=…` and waits for a row in it; the TMDB test uses `?section=content`.
- The torrent error toast links to `?section=streaming`; `lib/resolve.ts` copy says Settings › Streaming.
- The epic's tier table lists glass-thick for the "settings panes nav", but the ticket's layout has the list as plain items on the page, so no glass panel (left open).
- Status (2026-11-05): built and committed, not pushed (Actions down); `pnpm test` not run. Tests to watch: `settings.test.tsx` (new pane/keyboard/chip rail cases), `app-shell.test.tsx` (⌘, last pane), `streams.test.tsx`, `tmdb-dialog.test.tsx`, `server-dialog.test.tsx`, `contrast.test.ts` (new "Settings pane label, current").
- Screenshot harness as in [[app-shell]]; stub `tracking.Status` with SIMKL connected to show the toggles.
