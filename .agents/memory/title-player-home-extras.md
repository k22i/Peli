---
name: title-player-home-extras
description: "UI audit task D (2026-11-19): Ends at (lib/ends-at, useClock), spoiler protection (ProfileSettings.hideSpoilers, lib/spoilers, reveal per episode), ← → page Home's marquee (lib/marquee), component shot rig gotchas"
metadata:
  type: project
---

Three extras on the title page, the player and Home:

- **Ends at:** `lib/ends-at.ts` holds the pure maths (`endsAt(now, remaining s, speed)`, `clockTime` via `Intl.DateTimeFormat` with hour "numeric" so the locale picks 12/24 h, `runtimeSeconds` for addon runtimes like "49 min"/"1h 30min", `remainingSeconds(runtime, progress ms)`) and `useClock(step)` aligned to the clock. The title page's `TitleMeta` shows it last (second on the phone's one line, so genres clip first) for what Play plays (`endsAtFor`: film runtime, else the chosen episode's runtime or the series'). The player's `PlayerEndsAt` (`components/player/ends-at.tsx`) sits after the time remaining in the desktop dock and the touch seek row (not mini), ticking each second so it moves while paused and counts speed.
- **Spoiler protection:** `ProfileSettings.HideSpoilers` (Go `json:"hideSpoilers"`, default off; Settings › Addons & content › Episodes › "Hide spoilers"; kids get the same switch). `lib/spoilers.ts`: `hidesSpoilers` = on and not watched and not started and not revealed; revealed ids are a module-level set for the session (`useSyncExternalStore`), `resetRevealed()` for tests. Covered: title page episode rows (blurred still + `aria-hidden` overview, a sibling "Reveal S1 · E2" icon button; focus moves to the row after), the player's next-episode card (still is a reveal button), the touch Episodes sheet ("Reveal pictures" for the season). Home/Library/Upcoming cards show posters, not episode stills, so nothing blurs there.
- **Home marquee:** `heroArrowStep` (`lib/marquee.ts`) maps ← → (no modifiers, not in a text field). `CatalogHero` adds a native keydown listener on its wrapper (jsx-a11y rejects onKeyDown on a div), refocuses the same control after the keyed Hero remounts (from a dash, the new current dash, `data-marquee-dot`), and announces "2 of 5: Name" in an sr-only live region. Reduced motion still never auto-rotates.

**Why:** UI audit task D; the coordinator said not to run vitest, so the new tests (ends-at, spoilers, marquee, PlayerEndsAt, home/title/settings route cases) were written but not run.

**How to apply:**
- Shot rig: component-only `frontend/.shot/` (excluded in `.git/info/exclude`), config needs a `@bindings` alias too, port 9364, scenes title/player/spoilers/revealed/setting. `h-screen` computes 0 height in this app's CSS; use an inline `100vh`.
- Go `TestSettingsPersistPerProfile` already failed on main (its expected device defaults lack `AutoUpdate: true`), so `HideSpoilers` persistence there isn't proven by it.
- Related: [[title-page-redesign]], [[home-hero]], [[settings-panes]], [[player-controls]], [[hero-contrast]].
