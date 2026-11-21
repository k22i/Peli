---
name: local-node-version
description: Node 24.9.0 on this machine fails subtitles.test.ts because Intl.Locale("und").language is undefined; the repo wants ^24.11.0
metadata:
  type: project
---

`frontend/src/lib/subtitles.test.ts` › `subtitleLanguage` › "reads ISO 639 codes, OpenSubtitles' own, and anything else" fails on this machine at `subtitleLanguage("und")` — expected `{ language: "und", code: "" }`, got `{ language: undefined, code: "" }` — and it fails on `main` at 247c91b, before any party work. It is the local Node, not the code.

**Why:** `Intl.Locale("und").language` is `undefined` under Node **24.9.0** (its ICU predates the fix); `subtitleLanguage` reads `locale.region || locale.script ? locale.baseName : locale.language`, so an `und` with neither region nor script falls through to that `undefined`. `frontend/package.json` wants `^22.18.0 || ^24.11.0 || >=26.0.0`, and pnpm prints an "Unsupported engine" warning with every script. `src/routes/profiles.test.tsx` also flaked once under a full-suite run with `ECONNREFUSED 127.0.0.1:3000`; it passes on its own.

**How to apply:** treat that one test as environmental until Node is on 24.11+ (or 22.18), and don't pin it on the branch under review. Check with `node -e 'console.log(new Intl.Locale("und").language)'`: `undefined` means the old Node. Related: [[test-suite-green]], [[frontend-stack-preferences]].
