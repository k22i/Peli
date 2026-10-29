---
name: addon-manager
description: "How Sinag's addon manager (#38) and Home's no-addons state (#39) are laid out, their edits and the stubbed-screenshot harness gotchas; read before anything that installs addons"
metadata:
  type: project
---

The addon manager (#38, ADR-0024) is `routes/addons.tsx` plus `components/addons/` (`addon-row.tsx`, `addon-dialogs.tsx`: `InstallDialog`, `ConfigureDialog`). Edits go through `useEditAddons` (`lib/addons.ts`): kinds install, insert (undo), reconfigure, remove, move, enable, applied optimistically with `applyAddonEdit` and run in one mutation scope. Go: `Store.InsertAddon`/`ReplaceAddon` (the latter rewrites the kids allow-list), `account.Service.InsertAddon`/`ReconfigureAddon`.

**Why:** a pulled list must never be overwritten by one the page read earlier (ADR-0019), and order changes must hit catalog/stream routing at once.

**How to apply:**
- Run edits from UI with `useAddonEdits(profile)` (`components/addons/addon-edits.tsx`: `run`, `install`, PIN `dialog`), shared by the manager and Home's `NoAddons` (#39). Anything that decides "does this profile have addons to browse" uses `visibleAddonsQuery` (key `["addons", id, "visible"]`, refreshed by edits, pulls and kids-scope changes).
- The content disclaimer lives once in `lib/disclaimer.ts` (welcome + Settings › About); reuse it rather than rewording. UI copy names no addon and links to no content.
- Use `mutateAsync` per edit, not per-call `mutate` callbacks (TanStack only fires them for the last call); `needsParentPin(error)` in `lib/account.ts` re-asks the PIN.
- Show only an addon's host (`host()` in `addon-row.tsx`); the path can hold a debrid key.
- Tests: jsdom has no DragEvent (no `clientY`), so a drop lands "after"; fake `dataTransfer` needs `types: []` or the Wails runtime's file-drop listener throws; make the fake `MoveAddon` update `mocks.addons`, since `onSettled` refetches.
- Stubbed screenshots: alias `@bindings/*` to stub files that `export *` from the real bindings and override `Service` with a Proxy; reach `/addons` by clicking "Profile: Kevin" then the "Addons" menuitem. Related: [[addon-protocol-client]], [[kids-profiles]], [[spike-ticket-workflow]].
