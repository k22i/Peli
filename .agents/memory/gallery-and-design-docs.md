---
name: gallery-and-design-docs
description: "#125 docs part: README layout (rules, then record by ticket), which screenshots were removed or marked stale, gallery sections and samples, the contrast pair fix, how the gallery shots are taken"
metadata:
  type: project
---

#125 (redesign epic [[redesign-epic]]) rewrote `docs/design/README.md`: identity rules, where things live, rules of thumb, Glass, Type, Cards/rails/hero, Motion, Shell, a "Gallery screenshots" table, then "Record, by ticket" (pre-redesign #20–#24, #95, #52, then #111–#124 in order), then a `## #125` section. The QA section was left for the coordinator to add after it.

- **Removed screenshots** (screens the redesign replaced, listed in the README): `native-welcome-dark`, `settings-signed-in/session-ended/profiles-light`, `stream-picker-dark`, `stream-picker-file-name-light`, `menu-switch-profile-dark`, `sign-out-dialog-dark`. **Marked stale, kept:** `native-home-dark` (not refreshed: no Screen Recording permission; retake from the built app), `menu-guest-dark`, `menu-session-ended-dark`, `shell-native-welcome-dark`. `…-before` shots are the old look on purpose.
- **Gallery** (`components/gallery/`): new `glass-buttons.tsx` (solid Play + `glass-media` over art; `pillButton`/`glassButton` on the page), `rail-sample.tsx` (a `ScrollRail` of cast circles), `player-bar-sample.tsx` (the real `SeekBar` in a `glass-media-strong` capsule; a copy of the player's button layout, not the real `ControlButton`). `materials.tsx` exports `busy` (the stripe backdrop). Order in `Components`: Hero, Rows, Cards, Buttons, Glass buttons, Chips and badges, Scroll rail, Player bar, Overlays, Skeletons, Stream picker, Long rows. `gallery.test.tsx` checks the new headings, the Seek slider, "Back 10 seconds" and the Cast region (written, not run).
- **Contrast gotcha:** `contrastPairs` "Shortcut hint" listed `--muted` (translucent) alone and measured 3.53:1 in light; the gallery's live table showed Fail. Fixed with `["background", "glass-regular", "muted"]`. List translucent backgrounds with the layers under them.
- **Gallery screenshot rig:** throwaway `frontend/vite.shot.config.ts` aliasing `@bindings/<name>` to Proxy stubs, `@/lib/platform` and `@wailsio/runtime` to stubs (copy a previous worker's `stubs/` and `runtime.ts`, fix the absolute `bindings` paths in `stubs/store.ts` and `player.ts`), `/#/gallery`, then a CDP script that scrolls `#content` so a section's `h2` sits 70px down. Gallery needs no real art. Clicking "File name" buttons in the gallery's picker via `.click()` did not reveal file names (didn't dig).
- Status (2026-11-06): committed on `k22i/redesign-125-docs`, not pushed (Actions down), `pnpm test` not run.
