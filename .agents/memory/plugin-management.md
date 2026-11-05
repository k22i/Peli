---
name: plugin-management
description: "#57/ADR-0047 plugin management: per-profile master switch off by default, repositories synced like addons (Nuvio's plugins table), plugin on/off and settings local, kids never, Settings › Plugins, test and screenshot rig"
metadata:
  type: project
---

#57 (ADR-0047) is `internal/plugins/manage.go` + `internal/store/plugins.go` + `internal/backend/plugins.go` + `components/settings/plugins-pane.tsx`. Nuvio's `plugins` table holds **repositories** (`url` = manifest URL, `name`, `enabled`, `sort_order`, `repo_type` NUVIO_JS / EXTERNAL_DEX / null), not plugins; it replaces whole on push, no pull RPC (PostgREST read), `uses_primary_plugins` → profile 1's list. Plugin on/off, settings and the master switch are local per profile (`store.PluginConfig`, key `plugin-config`; the synced list is `plugin-repos`).

**Why:** mirror how Nuvio's apps split it; consent is per person; unvetted scrapers must fail closed.

**How to apply:**
- `Plugins.Installed()` = enabled plugins of enabled, `Runnable()` repos from the profile in use's cache; empty when switch off or `Profile.Kids`. `Streams` only runs a plugin that `Installed` lists (same id + URL) and uses stored settings. `SINAG_DEV_PLUGINS` is gone; `tools/plugins` uses `plugins.ManifestPlugins` + `RunUnchecked` (package funcs, not bound).
- Edits go through `plugins.UseStore(svc, open, account.EditorOf(accounts))` (the addon guard: lock + parent PIN) and refuse kids with `ErrKids`. `InstallRepository`/`Refresh` refuse while off (no network).
- EXTERNAL_DEX/.cs3 rows stay in the list and survive pushes (`mergeByURL` shared with addons). Pull replaces the list; `prunePluginCaches` drops removed repos' plugins; `Refresh` (called by `installedPluginsQuery`) reads manifests with no cache or a day old, 5-min retry gap on failure.
- New nuvio calls: `Client.Plugins/PushPlugins`, `nuviotest` `SyncedPlugins`, contract entries `/rest/v1/plugins`, `sync_push_plugins`; `backend` test helper `device.pull` lists `SurfacePlugins`.
- Frontend: `lib/plugins.ts` (`installedPluginsQuery(profileId)` keyed `["plugins", id, "installed"]`, `pluginsOverviewQuery`, `usePluginEdits`, `pluginEditProblem`); `surfaceQueryKeys.plugins`; pane id `plugins` after Streaming, kids lead "Kids profiles don’t use plugins."; source shown as host+path (no query). Route tests mocking `@bindings/plugins` should add `Refresh` (missing is tolerated: caught).
- No UI for `SCRAPER_SETTINGS` (stored, `Plugins.SetSettings` bound).
- Screenshot rig (throwaway, scratchpad): `vite.shot57.config.ts` copied into `frontend/` with `@bindings/<name>` aliased to stub files (`handlers.ts` keyed `service.Method`, `?scene=off|on|kids` in the hash), headless Chrome CDP on 9371, `shot.mjs` with an eval click. Delete the config afterwards.
- Status (2026-11-06): built, committed on branch `k22i/streams-57`, not pushed; no tests run (Go and vitest written only). Tests to watch: `internal/plugins/service_test.go`, `store/plugins_test.go`, `backend/plugins_test.go`, `nuvio` contract + `TestPluginsSync`, `account` `TestEditorOfAsksForTheParentPIN`, `plugins-pane.test.tsx`, `settings.test.tsx` (pane titles), `lib/plugins.test.ts`.
- Related: [[plugin-sandbox]], [[sync-module]], [[kids-profiles]], [[settings-panes]].
