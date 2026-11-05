---
name: redesign-qa
description: "#125 QA pass (checks 1-6): what was found and fixed, the CDP rig (shot.html entry, window.__h handlers, key helper), keyboard/reduced-motion/contrast probes, what is still open"
metadata:
  type: project
---

#125 (redesign epic [[redesign-epic]]) QA by a worker, checks 1-6 (screens, narrow, reduced transparency, increased contrast, reduced motion, keyboard). Fixes: Search status line `empty:sr-only` (no 56px gap), title Hero `-mb-8` (blank band under the fade), `--switch-off` token + off Switch thumb white + `motion-reduce:[transition:none]` (pairs in `contrastPairs`), Install/Configure dialogs return focus (`finalFocus`: ref for Install, `[data-addon-url] [aria-label^="More for"]` for Configure, since neither has a Dialog trigger), grid/rows keep a keyboard-focused card below the sticky header (`stickyInset` in `roving.tsx`, `scrollPaddingStart` state in `poster-grid.tsx`), and the `reduced-transparency` variant now also matches `prefers-contrast: more` (tiers go solid and get the border). Screenshots are in `docs/design/qa/`.

**Why:** the epic wants every screen checked in both themes and with the accessibility settings; the keyboard pass found two real bugs (focus lost after Esc, card hidden under the header).

**How to apply:**
- Dialogs opened without a `DialogTrigger` (controlled `open`) lose focus on Esc: pass `finalFocus` to `DialogPopup`. The Sign out alert, PIN and profile menu already return it.
- Anything that scrolls a focused card must clear the sticky header: use `stickyInset(el)` (lowest `position: sticky` header in the scroller). The virtualizer's `scrollPaddingStart` is reset on every render, so it must come from state, not `setOptions` alone.
- Rig (throwaway, outside the repo): `vite.shot125.config.ts` WITHOUT the wails plugin (it fails on an aliased runtime) aliasing `@/` (the `shot.html` entry sits outside tsconfig `include`), `@bindings/*`, `@/lib/platform`, `@wailsio/runtime` to scratch stubs; `shot.html` + `shot-main.tsx` expose `window.router`, `window.__idle`; stub handlers read `window.__h[key]` first (record or override calls per scene), scenes by `?scene=` (first-run, picker, locked, guest-sign-in, session-ended) plus `extra` flags (`qr=waiting`, `wrongpin=1`); a stub patches `fetch` to move a few Cinemeta episodes into the future for Upcoming; the sinag:// anime addon is answered by proxying Kitsu. Chrome 9325, `Emulation.setEmulatedMedia` takes `prefers-reduced-transparency`, `prefers-contrast`, `prefers-reduced-motion`.
- CDP keys: `Input.dispatchKeyEvent` needs `text` for Enter ("\r") and characters, modifiers Meta=4, Shift=8; Tab works for focus-visible. Wait ~5 s after Home/End in a 1,000-item grid (smooth scroll).
- "Before" shots: a detached `git worktree` at the base commit with `node_modules` symlinked and the same config pointing `@/` at it; start the dev server with `node <vite-plus-core cli.js> dev --config`, not `pnpm exec` (it tries `pnpm install` and aborts on the symlink, and the old server keeps answering).
- Reduced motion probe: compare `document.getAnimations()` over 700 ms with and without the emulation; only opacity/box-shadow fades remain.
- Open (left for the user): VoiceOver, built-app checks, Windows, card-size sign-off; README line about contrast-more still says "also gets a 1px border" (now solid too); Home/End on the episode list scroll the page instead of jumping to the first/last episode; tests not run, not pushed.
