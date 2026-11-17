---
name: bottom-sheets
description: "#134 bottom sheets on the iPhone: ResponsiveMenu/ResponsiveContextMenu/ResponsiveMenu* parts, ResponsiveSelect, BottomSheet drag (lib/sheet-drag), lib/sheets open count for the tab bar, haptic() stub, long press, screenshot rig"
metadata:
  type: project
---

Since #134 (epic #126, 2026-11-17) menus and selects are written once and render as Base UI popovers on desktop and the iPad full screen (`useCompactShell()` false), and as a bottom sheet on the compact iOS shell. Desktop markup is exactly what the coss parts drew before.

**Why:** the user wants native-feeling iPhone menus (no clipped popovers, drag to close); #132 (Library) and #137 (Settings/Search) build on these parts.

**How to apply:**
- `components/ui/responsive-menu.tsx`:
  - `ResponsiveMenu({ trigger, label, header, popupClassName, align/side/sideOffset })`: a button's menu. `trigger` = what `MenuTrigger` took (`render`, `className`, `aria-label`, `children`). On compact the trigger gets `aria-haspopup="dialog"`, `aria-expanded`, `data-popup-open`.
  - `ResponsiveContextMenu({ children (the card), items, label, header, finalFocus, triggerRef })`: right-click on desktop; on compact a 500 ms press (`longPressMs`, 10 px slop), the card children scale to 0.97 while pressed (`data-pressing` on a `contents` wrapper), `haptic("light")`, and the lift's click is swallowed. A `contextmenu` event (openOnContextKey) opens it too.
  - Items: `ResponsiveMenuItem` (onClick, disabled, variant destructive), `…LinkItem` (render=<Link>), `…Group`, `…GroupLabel` (13 pt uppercase in a sheet), `…Separator` (8 pt band in a sheet), `…Shortcut` (popover only), `…RadioGroup/RadioItem` (check at the end), `…Sub({ label, title, popupClassName })` = a second page with a Back row in a sheet (focus goes to Back, then back to the Sub row). `useMenuMode()` → "menu" | "context" | "sheet" for callers that draw something else in a sheet (profile header).
  - Never put raw `MenuItem`/`ContextMenuItem` inside these roots (or in `TitleMenu` `items` / `TitleMenuExtras`): in a sheet there is no Base UI menu around them.
  - Choosing a row runs the action, then closes the sheet.
- `components/ui/responsive-select.tsx` `ResponsiveSelect({ items, value, onValueChange, title?, size, className, id, aria-* })`: desktop = the old `<Select items>` + `SelectTrigger`/`SelectValue`/`SelectItem` block; `onValueChange` gets Base UI's raw value (null when cleared), so callers keep `next && …` or `next ?? ""`. Sheet title = `title`, else the `aria-labelledby` element's text. Moved onto it: Library Sort, every Settings select, audio languages, Browse and Search filters.
- `components/ui/bottom-sheet.tsx` `BottomSheet`: Base UI Dialog (`role=dialog`, `aria-modal="true"` set by hand, Base UI doesn't), `material-pop` (there is no `glass-thick` since the revamp), 28 pt top corners, 36×5 grabber, full width with safe-area padding, `max-h-[70dvh]`. Drag: pointer events on the handle (grabber + header, `touch-none`), and non-passive touch events on the rows once scrolled to the top (WebKit cancels pointers when a list scrolls). Rules in `lib/sheet-drag.ts` (reducer, `shouldDismiss` 25 % / 800 pt/s, `springEasing()` = CSS `linear()` spring; no animation library). Reduce Motion: fade, no slide, no spring. Base UI 1.9 also ships a `drawer` with swipe; not used, to keep the spec's thresholds.
- `lib/sheets.ts`: open-sheet count (`useSheetOpen()`, `sheetsOpen()`, `subscribeSheets()`). Each open sheet holds a `hideTabBar()` request from #129's `lib/tab-bar.ts`, so the native bar and the CSS capsule both hide (the capsule stays mounted, `inert` and slid away); `app-shell.tsx` has no sheet case of its own. See [[app-shell]].
- `lib/haptics.ts` `haptic(kind)` is a no-op for #135 to fill.
- Episode menu "Mark all up to here" stays a flat row (it was never a submenu); Tracking Status/Rate and Switch profile are the pushed pages.
- Tests: `components/ui/responsive-menu.test.tsx`, `lib/sheet-drag.test.ts`, one in `ios.test.tsx`; `onCompactIOS()` in `test/ios.ts` returns a restore for afterEach. jsdom stamps events with the real clock: set `timeStamp` with `createEvent` + `defineProperty` for velocity.
- Screenshot rig (not committed, no simulator): a scratch `frontend/shot134.html` + `src/shot134.tsx` rendering the parts with static items, served by `npx vite --port 9534`; headless Chrome with `--remote-debugging-port` and a CDP script (`Emulation.setDeviceMetricsOverride` 402×874 mobile, a user agent with `PeliIOS` so `isIOS()` is true, `pointer: coarse`). Desktop Chrome windows can't go below ~500 px, so `--window-size` alone clips. Shots: `docs/ios/epic126-134-sim-*.png`.

Related: [[ios-polish-epic]], [[ios-port]], [[title-menus]], [[picker-addons-popups]], [[tracking-ui]].
