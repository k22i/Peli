---
name: addon-manager
description: "How Sinag's addon manager (#38) is laid out, its edits and the stubbed-screenshot harness gotchas; read before #39 or anything that installs addons"
metadata:
  type: project
---

The addon manager (#38, ADR-0024) is `routes/addons.tsx` plus `components/addons/` (`addon-row.tsx`, `addon-dialogs.tsx`: `InstallDialog`, `ConfigureDialog`). Edits go through `useEditAddons` (`lib/addons.ts`): kinds install, insert (undo), reconfigure, remove, move, enable, applied optimistically with `applyAddonEdit` and run in one mutation scope. Go: `Store.InsertAddon`/`ReplaceAddon` (the latter rewrites the kids allow-list), `account.Service.InsertAddon`/`ReconfigureAddon`.

**Why:** a pulled list must never be overwritten by one the page read earlier (ADR-0019), and order changes must hit catalog/stream routing at once.

**How to apply:**
- #39's empty-state install action should open `InstallDialog` (or reuse `addonLink` + `manifestQuery`), not call Go directly.
- Use `mutateAsync` per edit, not per-call `mutate` callbacks (TanStack only fires them for the last call); `needsParentPin(error)` in `lib/account.ts` re-asks the PIN.
- Show only an addon's host (`host()` in `addon-row.tsx`); the path can hold a debrid key.
- Tests: jsdom has no DragEvent (no `clientY`), so a drop lands "after"; fake `dataTransfer` needs `types: []` or the Wails runtime's file-drop listener throws; make the fake `MoveAddon` update `mocks.addons`, since `onSettled` refetches.
- Stubbed screenshots: alias `@bindings/*` to stub files that `export *` from the real bindings and override `Service` with a Proxy; reach `/addons` by clicking "Profile: Kevin" then the "Addons" menuitem. Related: [[addon-protocol-client]], [[kids-profiles]], [[spike-ticket-workflow]].
