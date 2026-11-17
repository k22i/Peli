---
name: quick-actions
description: "#141 Home Screen icon menu: static Search/Library in Info.plist, dynamic Continue watching from the frontend, internal/quickactions (SetItems/TakePending + pending ping), PeliSceneDelegate hooks, ready gate for picker/PIN; widget decision notes"
metadata:
  type: project
---

Built 2026-11-17 for #141 (epic #126). No extension, no App ID cost.

**Layout:**
- `build/ios/Info.plist` and `Info.dev.plist` (tab-indented!) carry `UIApplicationShortcutItems`: `net.k22i.peli.search` (`magnifyingglass`), `net.k22i.peli.library` (`books.vertical`). Static items come first in the menu; the dynamic ones follow (iOS shows 4 in all).
- `internal/quickactions`: bound `Service` with `SetItems([]Item)` (Go `Clean` keeps ≤2 with a type, id and name) and `TakePending() *Action`. A tap (`peliQuickAction`, exported to ObjC) is stored as pending and only pings `quickactions:pending` (Void). iOS half sets `UIApplication.shortcutItems` (type `net.k22i.peli.title`, icon `play.circle`, userInfo type/id/videoId/title); desktop twin is a no-op. `build/ios/main.m` calls `peliHandleShortcutItem` from `scene:willConnectToSession:` (cold launch, `options.shortcutItem`) and `windowScene:performActionForShortcutItem:` (warm).
- Frontend `lib/quick-actions.ts`: `quickItems` (names from the library or cached addon meta; entries without a name are skipped; PIN-enabled profile → none), `useQuickActionSync` (debounced 1 s, clears at once when locked/empty, flushes on `visibilitychange` hidden), `useQuickActionHandler(ready)` in `routes/__root.tsx`. `ready` = not on a beforeProfile screen, a profile in use, and its PIN entered. A tap that arrives earlier waits in a ref (and in Go for a cold launch). Title items go through `usePlay`; Search → `/search` (its field autofocuses), Library → `/library`.
- `QuickActionSync` is mounted in both branches of `ProfileGate` so a PIN profile's gate also clears the previous profile's titles. Test setup mocks `@bindings/quickactions`.

**Why frontend, not Go, computes the items:** only the frontend knows a title's name for entries not in the library (addon meta).

**Widget (decision pending with the user):** SideSign registers and assigns App Groups (`AppGroups.swift`, `Entitlement.appGroups`), so a group should survive a free re-sign; an appex costs one more App ID (3 of 10/week, and the `.dev` build counts again). See the #141 comment for the verdict.

Related: [[crash-diagnostics]], [[ios-sidestore]], [[ios-polish-epic]], [[library-page]].
