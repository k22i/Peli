---
name: ios-polish-epic
description: Epic #126 (2026-11-17) iOS/iPadOS daily driver — sub-tickets #127–#142, priorities, the code findings behind them, and the design decisions (native glass tab bar, pairing for trackers)
metadata:
  type: project
---

On 2026-11-17 the user asked for an iOS/iPadOS UX pass after the first device runs. Epic **#126** has sub-tickets **#127–#142**, linked as GitHub sub-issues and on board project 4. Every ticket is in Backlog with Priority and Estimate set.
- Label `area:ios`.
- Milestone "iOS — daily driver" for P0/P1; P2 tickets (#140, #141) are in "Later".
- Priorities are relative to the epic. The P0 label's "MVP (v1.0)" description doesn't apply here.

**The user's asks:**
1. A floating Liquid Glass bottom bar like Instagram's (#129).
2. A smaller player UI after YouTube/Netflix/Infuse (#130), and brightness/volume swipes with a level HUD (#131).
3. The Library on mobile (#132).
4. Crashes, e.g. Home → Movies → Shows → Anime (#127, then #128).
5. Syncing SIMKL/AniList between Mac and iPhone/iPad (#133).

**Code findings the tickets rest on:**
- Wails' `WailsViewController` has no `webViewWebContentProcessDidTerminate:`, so a WebKit memory kill leaves a blank screen.
- No error boundary, no global JS error handlers, no Go `recover`/`SetCrashOutput`.
- The AniList addon uses `extraLarge` covers.
- The anime list is 5.9 MB, and `IMDbIDs` sends every id over the bridge.
- Anime catalogs use AniList's public API: no AniList sign-in is involved.
- Scrolling is the `#content` ScrollArea, so a status-bar tap doesn't scroll to the top.
- The touch player dock is about 45 % of a landscape iPhone's height.
- Tracker tokens are per device and per profile in the Keychain. SIMKL refresh returns the same refresh token, so a grant can be shared, but `DisconnectSimkl` revokes it for every device.

**Decisions written into the epic:**
- The tab bar is a native `UIGlassEffect` view over the webview, through a bound `internal/shell` service. Not Wails' `EnableNativeTabs` `UITabBar`: it shrinks the webview, so nothing scrolls under it. CSS fallback below iOS 26 and in tests.
- Native-only APIs go behind bound services with desktop no-ops, because bindings are generated from the desktop build.
- Tracker sync is QR pairing over the LAN, end-to-end encrypted. Rejected: tokens in Nuvio (ADR-0038), and iCloud Keychain (needs a paid shared team; revisit with a paid account).
- Any widget or extension costs a SideStore App ID.

**How to apply:** start with #127; #128 needs its diagnostics. Each ticket ends with a "Working on this ticket" section: local main, no push, board moves, device screenshots in `docs/ios/epic126-<n>-*.png`. Related: [[ios-port]], [[ios-sidestore]], [[ios-libmpv]], [[tracking-integrations]], [[local-only-git]].
