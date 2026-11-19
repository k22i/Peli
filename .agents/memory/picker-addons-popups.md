---
name: picker-addons-popups
description: "#122 stream picker, Addons page and coss popups: top pick glass card, stuck group heading overlay, StreamBadge (no tailwind-merge), alert dialog tier, screenshot rig with a local stream addon"
metadata:
  type: project
---

#122 (redesign epic [[redesign-epic]]) restyled `components/streams/` ([[stream-picker]]), `routes/addons.tsx` + `components/addons/` ([[addon-manager]]), the coss popups in `components/ui/` (menu, context-menu, select, dialog, alert-dialog, sheet, toast, tooltip; APIs unchanged) and the profile menu. Picker: `Ambient tone="art"` (TMDB backdrop, else the addon's, from the title cache), `PageHeader` (glass Back, h1 = the target's title, episode line from `playerHeading`), top pick = `glass rounded-3xl border-[1.5px] border-brand` with the quality + source as its name, solid brand Play pill with a `Kbd` P inside the row's button (so a click plays), rows `rounded-2xl px-4 py-3` with name (quality + source), muted addon, `StreamBadge`s and mono size/languages at the end.

**Why:** the user's Apple TV layout for the last in-app surfaces; tests pin the row text order (`^Top pick1080pBlu-ray`, `^Unknown qualityTorrentio$`), so the name is quality then source as separate spans with no space.

**How to apply:**
- The stuck group heading copy was replaced by the sticky toolbar + jump strip (C1, see [[stream-picker]]).
- `StreamBadge` (`stream-badge.tsx`) is a plain span: `cn()`/tailwind-merge reads the `text-meta` size token as a colour and drops a sibling `text-*` class, so never pass `text-meta` plus a colour through `cn` (coss Badge/Button do). The addon row's "Built in" uses it too.
- Alert dialogs had no tier (the CSS maps `data-slot="dialog-popup"`, the alert popup is `alert-dialog-popup`): it now has `glass-thick` as a class. Dialog/alert/sheet footers force `h-10` buttons with `*:data-[slot=button]`, since `Button` is not ours; the default footer is a `border-t` without the muted band.
- Menu items are `min-h-9 rounded-lg px-2.5 text-sm`, popup `p-1.5` (submenu `alignOffset` -7), labels uppercase; select trigger `min-h-10 rounded-xl`, `size="lg"` is `min-h-11`; sheets are `p-3` viewport + `rounded-3xl border` popup on every side.
- Rig (throwaway, outside the repo): `vite.shot122.config.ts` aliasing `@bindings/*` + `@/lib/platform` to scratchpad stubs (`Service` Proxy, handlers by `service.Method`, addons list mutated by Move/Remove/Install), a node server on :9522 serving two stream addons (Torrentio-style debrid, Peerflix-style P2P) for movie and episode ids, real Cinemeta for meta and art. With 2+ profiles the app redirects to `/profiles` on load: the CDP script clicks "Kevin" first, then sets `location.hash`. Headless Chrome needs `--disable-gpu-compositing`; "before" shots came from `git archive` of the start commit.
- Status (2026-11-05): built and committed, not pushed (Actions down); `pnpm test` not run. Tests to watch: `streams.test.tsx` (the new episode-line case, `Top pick` text order), `addons.test.tsx` (Built in), `app-shell.test.tsx` (profile menu status line), `contrast.test.ts` (new badge pairs).
