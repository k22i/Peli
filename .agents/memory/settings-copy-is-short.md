---
name: settings-copy-is-short
description: Settings descriptions stay to one short sentence; device scope is "This device.", warnings kept, no "Applies to this device."/"Off unless you turn it on." padding
metadata:
  type: feedback
---

The user asked for less yap in Settings: every `description` in `routes/settings.tsx` and `components/settings/*` is one short sentence (≈15 words), not two or three.

**Why:** the rows are read at a glance; the old copy repeated "Applies to this device.", "Off unless you turn it on." and restated the toggle's own label.

**How to apply:**
- Say what the setting does, then one qualifier if it matters. No restating the label, no second explaining sentence.
- Device scope: end with "This device." (never "Applies to this device."). Profile-wide: say nothing.
- Keep safety facts (peer-to-peer sees your IP, debrid list additions, telemetry never sends your library); cut the wordiness around them, not the fact.
- Drops that are always fine: "Off unless you turn it on." (a switch shows that), "Optional.", "You can change it while you watch, too." unless it is the point.
- Tests pin some copy: `settings.test.tsx`, `ios.test.tsx`, `downloads-settings.test.tsx`, `livetv-settings.test.tsx`, `plugins-pane.test.tsx`. Grep the old wording before you rewrite a row. See [[settings-panes]].
