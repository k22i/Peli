---
name: command-palette
description: ⌘K palette — components/shell/command-palette.tsx + lib/palette.ts, coss command added, Entry groups, focus return via opener ref, where it is mounted, test gotchas
metadata:
  type: project
---

⌘/Ctrl+K opens `CommandPalette` (`components/shell/command-palette.tsx`), mounted by `app-shell.tsx` only in the default chrome, so never on the player, the focus screens, or over a PIN-locked profile (it reads `currentProfileQuery` + `useUnlockedProfiles`). Built on coss `command` (`ui/command.tsx`, `ui/autocomplete.tsx`, added with `shadcn add @coss/command`; `input.tsx` and `scroll-area.tsx` must NOT be overwritten, they are customised). Rules live in `lib/palette.ts` (`isPaletteShortcut` skips defaultPrevented, `commandMatches` word-prefix, `recentTitles`).

**Why:** keyboard-only jump to titles and pages without a new nav item.

**How to apply:**
- Entries are `{id,label,keywords,run}` in groups (Recent / Go to / Movies / Shows / Anime); filtering is ours (`filter={null}`), search is the Search page's own rule (`useBrowsableAddons`, `searchCatalogs`, `searchGroups`, `useLeaveOutAnime`), debounced `searchDebounceMs`, 5 per group, so kids visibility stays fail-closed.
- Kids profiles get no Addons command (the menu asks a parent PIN). Switch profile goes to `/profiles`.
- Base UI's `finalFocus: true` did not return focus with no trigger: the shortcut handler stores `document.activeElement` in `opener`, `finalFocus` returns it (false after running a command, so the shell's focus-the-page hook wins).
- Popup motion/material: `data-slot="command-dialog-popup"` was added to the dialog-popup CSS rules in `index.css`, in its own background rule (`materials.test.ts` pins the dialog/sheet pair regex).
- Tests: the palette test mocks `@bindings/store` with a Proxy whose unknown methods never resolve, so pages behind a command stay loading. Option names are label+hint concatenated ("Dune2021"). Full `pnpm test` is flaky under load (baseline had ~70 timeouts); run files alone to judge.
- Not verified in a real window.
