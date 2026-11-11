---
status: accepted
date: 2026-11-11
---

# Rename to Peli: a pelican mark, and an existing install moves across on first run

The app was called Sinag (Tagalog for a ray of light, chosen in #82 over Cove). On 2026-11-11 it became **Peli**: a short, friendly name that plays on the pelican, and is Spanish slang for a film. The mark is a pelican whose head and pouch make a play button.

## Decisions

**Everything that says the name moves.** The repo is `k22i/Peli` (GitHub redirects `k22i/Sinag`), the module is `github.com/k22i/Peli`, the binary `peli`, the bundle id `k22i.net.peli`, the keychain service `Peli`, the data folder `Peli/peli.db`, the cache folder `Peli`, screenshots go to `Pictures/Peli`, environment variables start with `PELI_`, and built-in addons use `peli://` (ADR-0045). Recorded results under `spikes/*/results` stay as measured. Earlier ADRs now say Peli where they meant the app.

**An install from the Sinag days moves on first run, without asking.** The app was never released, but its own developer has a real library, sessions and settings in it.
- *Folders.* `store.MoveFromSinag` runs before anything opens them: `Sinag/` in the app-data folder becomes `Peli/` (and `sinag.db` becomes `peli.db`), and the Sinag cache folder becomes Peli's. A folder is left alone when Peli's already exists, and nothing moves with `$PELI_DATA_DIR` set.
- *Keychain.* Items can't be listed portably, so they move one at a time as they're read: the app's keychain (`secrets.Keychain.MovesFrom`) falls back to the `Sinag` service for a key it doesn't have, files the value under `Peli` and deletes the old item. Delete removes a key from both, so a key signed out of before it was read can't come back. On macOS the first read of each old item may ask for keychain access once, since the binary that made it was Sinag.
- *Built-in addons.* Schema 4 rewrites `sinag://` addon URLs, and the list of built-ins already offered, to `peli://`, so AniList keeps its place and switch and isn't offered again. Nuvio's copy never had them.

**Ids other devices or Nuvio keep stay as they are.** The AniList addon's manifest id is still `sinag.anilist`: Home layouts and collection folders name catalogs `addonId:type:catalogId` and sync them to Nuvio. A device id already made (`sinag-…`) is kept; new ones start `peli-`.

**The design tokens keep their names.** `--sun`, the `sun` button variant and the `sun` ambient tone are the amber accent, which is also the pelican's bill. Renaming them is churn with no change on screen.

## The mark and the icon

`PeliMark` (`frontend/src/components/shell/wordmark.tsx`) is the pelican in `currentColor`, with the eye and the line of the bill cut out: a round head with a curly crest, a feathered nape, and a bill and pouch that make a play triangle. It replaces Sinag's low sun in the top bar, the welcome screen and the gallery.

The app icon is the same pelican in cream on an amber tile (`build/appicon.svg`, rendered to `build/appicon.png` at 1024 px; `icons.icns` and `icon.ico` come from it through `wails3 generate icons`). The macOS 26 Icon Composer bundle (`build/appicon.icon`: an automatic amber gradient, the pelican and its features as two SVG layers) needs Xcode's `actool` to become `Assets.car`; the Wails one is deleted until then, so macOS uses `icons.icns`. The DMG gets a Peli background, and the `.dmg` file uses the app icon instead of Wails' drive.

## Consequences

- Run `wails3 task common:generate:icons` on a Mac with Xcode to make `build/darwin/Assets.car` from `build/appicon.icon`, and check it in Icon Composer's light, dark and tinted previews.
- Trademark, domain and store checks for "Peli" are still open in #82. Peli Products (Pelican's protective cases in Europe) is in a different trade class.
- The OAuth apps registered with SIMKL, AniList and MyAnimeList still carry the Sinag name on their consent screens until they're renamed in each dashboard. Their client ids and redirects don't change.
