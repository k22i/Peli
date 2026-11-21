---
name: test-suite-green
description: 2026-11-20 the old test baseline was fixed (vitest 0 failures, Go all ok, pnpm check clean); the setup.ts import that caused it and other jsdom gotchas
metadata:
  type: project
---

On 2026-11-20 the whole suite went green: `pnpm test` 1232 passed, `go test ./internal/...` ok, `pnpm check` and `go vet` clean. The "baseline failures" older notes mention ([[title-menus]], [[ios-port]], [[library-housekeeping]]) are gone, so a failure now is a real one.

Causes worth knowing:
- **Never import app modules at the top of `src/test/setup.ts`.** A module the setup file loads is evaluated before a test file's `vi.mock` applies, so its whole import chain keeps the real bindings. `@/lib/anime` → `@/lib/settings` → the real `@bindings/store` made every settings query fetch the Wails runtime and hang (most of the ~60 old failures). It's now a lazy `await import()` inside `afterEach`.
- **Accessible names drop a leading space inside an inline child.** `Movies<span> · Cinemeta</span>` is named "Movies· Cinemeta". Keep the space outside the span (search rows, player menu hints).
- **The tree under ProfileGate must not change shape when the profile id arrives.** `TitlePrefetchProvider` is always rendered (profileId may be undefined), otherwise every page mounts twice.
- **Route tests need `@bindings/secrets` mocked with `Get`.** TitlePrefetch reads the TMDB key on every route. Without it the test sends a real fetch, and you see `url.includes is not a function` or unhandled `fetch failed` rejections.
- **Base UI submenu radio items don't select with `user.click` in jsdom.** Focus them and press Enter instead (more-menu.test.tsx).
- **The iPhone touch player needs `onCompactIOS()`.** `onIOS()` alone is iPad regular width, where the bottom row always shows (#138).
- **Nothing in the touch player's chrome is accessible until a state arrives.** `emit("player:state", playing)` (or `withTracks`) right after `openPlayer()` gives the controls their roles; queries before that see the markup but no accessible roles.
- **Base UI's `onOpenChange` takes a second argument** (the trigger's event details, e.g. `{ reason: "escape-key", event }`), so assert `toHaveBeenCalledWith(false, expect.anything())` on sheets.
- `renderApp` waits up to 10 s for the shell, because the first render in a file loads routes cold.

**Why:** these were hidden behind a baseline everyone was told not to chase.
**How to apply:** keep the suite at zero; when adding a binding call to the shell or ProfileGate, add it to the route test mocks (or setup.ts).
