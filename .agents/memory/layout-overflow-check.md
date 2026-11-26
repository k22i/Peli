---
name: layout-overflow-check
description: "Prove a screen fits a phone with no browser tool: dump the rendered route from jsdom, lay that markup out in real WebKit at 393/375/320 pt, and read back which nodes cross the edge"
metadata:
  type: project
---

The repo has no Playwright/Puppeteer, so jsdom tests say nothing about layout; a narrow-screen overflow has to be measured in WebKit. The recipe (throwaway files, delete them after):

1. A temporary `src/<name>-dump.test.tsx` mocks the bindings it needs (copy `src/ios.test.tsx`'s store/account mocks; `@bindings/party` needs every method `PartyChat`/`PartyPanel` touch, or the route's error boundary replaces the page), renders `renderApp("/party")` with `onIOS()` and `matchMedia` forced to `compactQuery`, and `writeFileSync`s `document.body.innerHTML`.
2. A harness `frontend/dist/_x.html` (inside `dist` so the CSS's relative font URLs resolve): `<html class="dark" data-platform="ios">`, `<link rel="stylesheet" href="assets/index-*.css">` — relative, an absolute `/assets/...` path 404s from `file://` — the dumped body, and a `window.__report()` that lists elements whose rect crosses `documentElement.clientWidth` plus every `scrollWidth > clientWidth`.
3. A ~60-line `swiftc` tool (AppKit + WebKit): a borderless `WKWebView` at the wanted size off screen, `loadFileURL`, then `evaluateJavaScript("window.__report()")` and `takeSnapshot`.

**Why:** the symptom "the page scrolls sideways" is `#content`'s `scrollWidth > clientWidth`; reading the failing nodes names the culprit in one pass instead of guessing at classes.

**How to apply:** the classic culprit is a text `<input>` with no `w-full min-w-0` inside a bare `grid` — its 20-character intrinsic width sizes the `auto` track, and the whole column grows. `grid-cols-1` (`minmax(0,1fr)`) is the structural fix. Rebuild the frontend (`pnpm build`) before measuring, or the new utility isn't in the CSS. `frontend/dist` is build output, not committed. See [[watch-party]], [[frontend-stack-preferences]].
