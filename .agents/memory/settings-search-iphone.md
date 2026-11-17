---
name: settings-search-iphone
description: "#137 Settings as a pane list and Search with the on-screen keyboard on the compact iOS shell: SettingsRoot/CompactPage, Back via TopBar, Choice→sheet, DialogPopup sheet, lib/keyboard.ts (--keyboard-h, dismiss on scroll, primeKeyboard), RecentList swipe"
metadata:
  type: project
---

#137 (epic [[ios-polish-epic]], 2026-11-17) made `useCompactShell()` branches in Settings and Search. Desktop and the iPad full screen render as before. Built without running anything (no simulator, tests left for the user): verify on a device (`ios/README.md` check 13).

**Why:** Settings was a chip rail over one long pane with desktop rows; Search's tall sticky header ate the room above the keyboard and the keyboard was never seen.

**How to apply:**
- Settings at compact: `/settings` with no `?section=` is `SettingsRoot` (settings-section.tsx): profile row (link to `/profiles`, "Switch profile"), then `visiblePaneGroups()` (panes.ts: account | content–plugins | tracking | appearance–about) as inset lists of 29 pt coloured icon tiles (`tone`) + chevron. Rows are `Link`s that **push** `?section=`; the pane is `SettingsPaneView` → `CompactPage` (34 pt title collapsing into a 44 pt glass bar, same IntersectionObserver trick as #132). `TopBar` draws Back on `/settings` when `section` is in the search (`BackLink fallback`). The ⌘, `lastOpenPane` path still works.
- `SettingRow` at compact: 17 pt label, 13 pt detail, control at the end (max 55 %), descriptions over 64 chars go full width under the row (footer-like); select triggers lose their width/pill via arbitrary variants on the control wrapper. `SettingsGroup` is `rounded-xl`, 13 pt eyebrow and footer. `Choice` (segmented) renders a `ResponsiveSelect` sheet at compact, so every choice opens #134's sheet.
- `DialogPopup sheet` prop: at compact a full-height sheet (28 pt top corners, safe-area padding, bottom padded by `--keyboard-h`). Used by TMDB, server, SIMKL and AniList dialogs. TMDB has a Paste button (compact only; `navigator.clipboard.readText`, iOS asks) and `autoCorrect/autoCapitalize off`.
- `lib/keyboard.ts`: `keyboardInset(layoutHeight, visualViewport)` (≥ 100 px counts), `useKeyboardInset()` (mounted in app-shell; writes `--keyboard-h` and `data-keyboard` on `<html>`, `scrollTo(0,0)` when it closes), `shouldDismissKeyboard` (10 pt) with `useDismissKeyboardOnScroll(pane, compact)` (touchmove blur), `primeKeyboard()` (focus a hidden input inside the tap; the CSS tab bar's Search calls it; the **native** bar's `shell:search` event has no gesture, so its keyboard may not open until a device says otherwise). `#content` pads `max(--tabs-float, --keyboard-h)`.
- Search at compact: `Frame` = sr-only h1, a non-sticky 44 pt field under the top strip, one `ChipRail` (kinds + decade/genre as `FilterSelect chip` sheets), `RecentList` (recent-list.tsx; swipe left → Delete via `lib/swipe-row.ts`, "Clear" in the header), `PhoneNotice` sizes empty/error states to the space above the keyboard/tab bar. Return blurs the field.
- Not done: tests (settings compact navigation, `keyboardInset`, `swipe-row`, `RecentList`), device screenshots `docs/ios/epic126-137-*.png`.

Related: [[settings-panes]], [[search-page]], [[search-folder-layouts]], [[discovery]], [[bottom-sheets]], [[app-shell]], [[title-picker-iphone]].
