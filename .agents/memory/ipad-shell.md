---
name: ipad-shell
description: "#138 iPad: CSS bottom bar (moved from the top after the device run) + sidebar (user's choice over native), lib/input-devices (GCKeyboard via shell.HardwareKeyboard, pointer), useFeature, iosKeysOff, popover right-click, roomy player, one window"
metadata:
  type: project
---

#138 (epic #126, 2026-11-18) made the iPad at regular width (not `useCompactShell()`) its own shape.

**Decision (the user, 2026-11-18):** CSS glass for the iPad's section bar and sidebar, not #129's native view in a "top" placement. The bar was first a top capsule in the top bar. On the device (main ea3f274) it overlapped the top bar, and the user asked to move it to the bottom. It is now #129's CSS `TabBar` with `centred` (bottom centre, at most 560 pt + gutters, the iPhone's look), and the top bar keeps only the wordmark, the sidebar button and the profile. A native sidebar would have needed a dynamic Collections list over the bridge, UIPointerInteraction, and focus and VoiceOver order outside the webview (~3 days, against ~1.75). The native Liquid Glass bar stays on the compact bottom bar only; `TabBarState.placement` stays "bottom".

**How to apply:**
- Shell: `AppShell` computes `ipad = isIOS() && !compact` and `sidebar = ipad && useSidebarShown()` (`lib/sidebar-choice.ts`, localStorage `peli.ipad-sidebar`, per device).
  - `ipadTabs = ipad && !sidebar && browsing` draws `<TabBar centred>`, which never minimises on scroll (the user, 2026-11-19: the iPad has the room; the phone bar still does); `tabsShown = nativeShown || ipadTabs` drives `useTabBar`, the `--tabs-float` bottom padding and `data-tabs` (toasts, and the Library `selection-bar`, lift above it).
  - `useNativeTabBar` gets `nativeShown` (compact only), so the native glass never shows on the iPad.
  - `TopBar` takes `ipad={{sidebar, onShowSidebar}}`: it draws no sections nav on iOS at regular width, and a `ShowSidebarButton` sits at the leading end. With the sidebar on, the root gets `sidebarInset` (`--ipad-sidebar`), and `<main>` and the header start at `start-(--ipad-sidebar)`: the page sits beside the sidebar, not under it. `IPadSidebar` (`components/shell/ipad-sidebar.tsx`) has Search, the sections (by `sectionOf`), then collections with folders → `folderPath`. ⌃⌘S toggles it in app-shell's keydown.
- Input devices: `lib/input-devices.ts` (`startInputDevices()` in `main.tsx`, iOS only): the keyboard comes from `Shell.HardwareKeyboard()` plus `shell:keyboard {attached}` (`internal/shell/keyboard_ios.m`, GameController; `TestIOSTabBarFiles` lists it). The pointer is `any-pointer: fine` or any mouse-type pointer event (sticky). `lastPointerType()` is the last pointerdown's type.
- `useFeature(name)` (`lib/features.ts`) re-renders on a keyboard change or a breakpoint change; `feature()` stays sync. On iOS, `desktopControls` and `commandPalette` follow the keyboard, `people` follows regular width, and `multiSelect` needs regular width and a keyboard. A new keyboard- or width-dependent call site must use `useFeature`, or it won't update live.
- Player: `iosKeysOff`/`iosShiftedOff` in `player-page.tsx` skip the keys whose Go calls are `ErrDesktopOnly` on iOS, or whose features are off. Pressing one would otherwise set state with nothing shown (S's `switcherOpen` blocked every key). `playerShortcuts` items carry `desktop: true` for the same list; keep the two in step. `roomy` (iPad regular width) → `bottomRow` for films too (Speed leaves •••), and `volumeSlider` while a keyboard or pointer is attached. The surface ignores mouse-type pointers for #131 gestures and clicks to pause.
- `ResponsiveContextMenu` in compact wraps the sheet path in a controlled Base UI `ContextMenu` that only opens when `lastPointerType() === "mouse"`; the inner `onContextMenu` stops propagation for the sheet path.
- A new Apple framework in a cgo file (GameController here) must also go on `build/ios/Taskfile.yml`'s final `clang` link line: the app links `peli.a` by hand, so `#cgo LDFLAGS` never reaches it, and the device build fails with undefined `_OBJC_CLASS_$_…`.
- One window: `UIApplicationSupportsMultipleScenes` stays NO; documented in `ios/README.md` "iPad (#138)".
- Not seen on a device: checks 12, 16 and 17 in `ios/README.md`. Unknown: whether WebKit on iPadOS sends a two-finger click's pointerdown as "mouse" before `contextmenu`; if not, the popover path never opens and the sheet shows instead.

Related: [[app-shell]], [[bottom-sheets]], [[touch-player-chrome]], [[player-keys-media]], [[ios-polish-epic]], [[ios-port]].
