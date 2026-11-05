---
status: accepted
date: 2026-11-06
---

# Plugin management: off by default per profile, repositories synced like addons, everything else on the device, never on a kids profile

#56 (ADR-0043) runs Nuvio's JS plugins in a sandbox but had no list of them: `Plugins.Installed` was empty unless a dev build named a manifest. #57 gives it a list the user controls: turn plugins on, install repositories, switch plugins on and off, and sync the list with Nuvio.

## What Nuvio's `plugins` table holds

Read from the self-host schema and from Nuvio's own clients (NuvioTV, NuvioDesktop, NuvioTVSmart) on 2026-11-06, since the spike doc only said "same for plugins".

- **Repositories, not plugins.** A row is `url` (the repository's manifest URL), `name`, `enabled`, `sort_order` and `repo_type`, per profile index. `sync_push_plugins(p_plugins, p_profile_id, p_origin_client_id)` replaces the whole list, like `sync_push_addons`. There is no pull RPC: the table is read through PostgREST, like addons.
- **`repo_type`** is free text. TV clients send `NUVIO_JS` or `EXTERNAL_DEX` (Android's Cloudstream `.cs3` repositories); Desktop sends none, and always `enabled: true`. Sinag runs `NUVIO_JS`, an empty type, and not `.cs3` URLs or `LEGACY`/`EXTERNAL_DEX`.
- **Not in Nuvio's table**: each plugin's on/off, its settings, and the master switch. Nuvio's apps keep these in local storage, per profile.
- `uses_primary_plugins` on the profile makes a secondary profile read and write profile 1's list.

## Decisions

**Off by default, with a warning.** The master switch (`PluginConfig.Enabled`, in the profile's bucket) starts off. Turning it on shows a dialog that says plugins are third-party scrapers, that Sinag sandboxes but doesn't vet them, that they can break or return fakes, and that the user is responsible for what they install. Turning it off needs no dialog. Go only records the answer; the dialog is the frontend's. While it is off, `Plugins.Installed` is empty, and so are `Streams` (it refuses with `not_enabled`), `Refresh` (no network) and `InstallRepository` (`off`).

**The switch is per profile and local.** Nuvio keeps the repository list per profile and everything else per profile on the device, and has no field for the switch. Sinag does the same: the switch, each plugin's on/off and its settings are in the profile's bucket and never pushed. A profile that uses the primary's plugins shares the repository list only; it still turns plugins on for itself, with its own warning. Per device would let one person's consent cover the whole family's profiles.

**The repository list syncs like the addon list (ADR-0019).** `SurfacePlugins` is a whole list, pulled whole every time, pushed whole, with `Push.Base` and a three-way merge on push (`mergeByURL`, now shared with `mergeAddons`). `Profile.UsesPrimaryPlugins` (new, kept like `UsesPrimaryAddons`) sends a profile's list to index 1. Rows Sinag can't run stay in the list and are carried through a push, since a push deletes whatever it leaves out and the phone would lose its Cloudstream repositories. Their `repo_type` and name round-trip; a row with no type pushes none. Sinag's own rows push `NUVIO_JS`. The row's `enabled` is a per-repository switch here and is respected from other clients.

**What a pull brings is a repository with no plugins.** Each profile keeps, per repository, the plugins its manifest listed when it was last read (`PluginCache`), with this profile's on/off and settings. `Plugins.Refresh` reads the manifests that have no list yet or are a day old, and the picker's `installedPluginsQuery` calls it first, so repositories from Nuvio start working without a visit to Settings. A repository that doesn't answer keeps its last list and isn't retried for five minutes. New plugins start as their manifest says (`enabled`), as Nuvio's do, but nothing is asked while the master switch is off. A refresh keeps on/off and settings. Plugin ids are taken as unique across repositories, as Nuvio takes them: edits apply to every entry with the id, and `Installed` asks one id once.

**Kids profiles never run plugins.** ADR-0014 left streams unlimited for kids, but plugins are unvetted scrapers, so a kids profile fails closed: `Installed` is empty for it whatever is stored, every plugin edit refuses it (`kids_profile`), and Settings › Plugins shows only "Kids profiles don’t use plugins." Edits go through `account.EditorOf`, which is the addon manager's guard, so changing any profile's plugins while a kids profile is in use needs the parent PIN, as addon edits do.

**Streams only asks what Installed lists.** `Plugins.Streams` takes the plugin from the frontend, as before, but only runs one that `Installed` returns for the profile in use (same id and code URL) and uses the settings kept for it, not the ones sent. A stale or compromised frontend can't run a plugin that is off, on a kids profile, or not installed. The sandbox, its limits and its host API (#56) are unchanged.

**`SINAG_DEV_PLUGINS` is gone.** It listed a manifest's plugins whatever the switch said, which is a way round "off means off". Installing the repository, in a dev build or not, does the same. `tools/plugins` now reads a manifest with `plugins.ManifestPlugins` and runs it with `plugins.RunUnchecked`, two package functions (not methods, so Wails doesn't bind them) that the app never calls.

**Where it lives: a Settings pane.** Settings › Plugins (`components/settings/plugins-pane.tsx`, after Streaming) rather than the Addons page: the switch, its warning and the per-profile nature match the settings pattern, and the Addons page is a flat, orderable list of one kind of thing. A repository is a group of rows: its name and source (host and path, never the query, which can hold a token), its own switch and Remove, then its plugins. A repository Sinag can't run is listed with Remove only.

**Install reads the manifest first.** The address gets `https://` and `/manifest.json` as Nuvio's apps do; the manifest is fetched (4 MiB, 512 plugins at most), `ParseManifest` reads it, and nothing is saved unless it lists a plugin for desktop. Go fetches the manifest and plugin code, as before; only the sandbox's own fetch is restricted to public addresses.

## Not done

- No editor for a plugin's settings (`SCRAPER_SETTINGS`). They are stored and sent (`Plugins.SetSettings`) but the pane has no UI for them: manifests don't describe their options, so a form would be a free-form editor.
- Repository order isn't editable; it is the order they were installed in, or Nuvio's.
- A repository's own `enabled` flag from another client is respected but Nuvio Desktop always pushes `true`, so it never turns one off.

## Consequences

- Existing installs have no plugins and the switch is off, so nothing changes until the user turns it on.
- A new Nuvio call (`Client.Plugins`, `PushPlugins`) is in `internal/nuvio/sync.go`, with its contract entries and fake-server support.
