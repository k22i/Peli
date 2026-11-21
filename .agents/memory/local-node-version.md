---
name: local-node-version
description: Login shells get nvm's Node 26.3.0, but agent shells without nvm (mistral-vibe workers) fall back to Homebrew's Node 24.9.0, where subtitles.test.ts fails on Intl.Locale("und")
metadata:
  type: project
---

This Mac has two Nodes: nvm's **v26.3.0** (`~/.nvm/versions/node/v26.3.0`, first on PATH in a normal shell) and Homebrew's **24.9.0** (`/opt/homebrew/bin/node`). Shells that don't load nvm, such as the mistral-vibe Orca workers on 2026-11-21, get 24.9.0. `frontend/package.json` wants `^22.18.0 || ^24.11.0 || >=26.0.0`, so pnpm warns "Unsupported engine" there.

Under 24.9.0, `src/lib/subtitles.test.ts` (`subtitleLanguage("und")`) fails, because `Intl.Locale("und").language` is `undefined` in that ICU. It passes under 26.3.0: the full suite was 1283 passed on 2026-11-21.

**Why:** a worker reported that failure as a problem with "this machine". It's really the Node its shell picked up.
**How to apply:** run tests with nvm's Node (`node --version` should print v26.x). If a worker reports that subtitles failure, check its Node version first. Check with `node -e 'console.log(new Intl.Locale("und").language)'`; `undefined` means the old Node. Related: [[test-suite-green]], [[frontend-stack-preferences]], [[orca-worker-model]].
