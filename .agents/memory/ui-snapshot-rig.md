---
name: ui-snapshot-rig
description: "See a component with no browser tool: a throwaway scene in the git-ignored frontend/.shot, a vite dev server, and a swiftc WKWebView that snapshots it to PNG"
metadata:
  type: project
---

There is no Playwright here, so a look-at-it task (corners, spacing, materials) is done with a snapshot rig:

1. A scene in `frontend/.shot/` (git-ignored): `<name>.html` with `<script type="module" src="/.shot/<name>.tsx">`, and a `<name>.tsx` that imports `@/index.css`, adds `.dark` to `<html>`, and renders the real components (pops open with `defaultOpen`/`open`). Run it with `pnpm exec vp dev --config .shot/shot.config.ts` (port 9391) as a **background process** — a `bash` call's child dies with the call.
2. `frontend/.shot/snap.swift` → `swiftc -O snap.swift -o snap`, then `./snap <url> <out.png> [w] [h] [wait] [dark|light]`: an offscreen `WKWebView`, `takeSnapshot` to PNG. `frontend/.shot/evaljs.swift` is the same view but prints the result of a JS expression (measure rects, read computed styles).
3. Read the PNG back with `read_file`.

**Why:** the bug class ("a rounded box with square corners around it", "the row scrolls sideways") is only visible once WebKit paints it; jsdom says nothing about paint.

**How to apply:** two opaque-ish background layers stack into a visible square — check whether a popup carries its surface twice (coss's `select` popup had a material `div` inside a popup that `index.css` also paints with `material-pop`). A translucent pop (`--pop` is 90 %) also shows whatever sits behind it: `alignItemWithTrigger` put the select's trigger pill under its own popup, and the pill ghosting through read as a second, rounded dropdown. Dark only — the light tokens never apply (#143). See [[layout-overflow-check]], [[peli-design-direction]].
