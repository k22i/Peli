---
status: accepted
date: 2026-11-20
---

# The Anime tab follows the poster addon: one card per IMDb title, opening that title

Amends [ADR-0045](0045-anime-from-anilist.md). AniList lists one entry per season or cour, and the user's poster addon (Xperience, BetterPosters…) and search list one IMDb title per show. So Black Clover showed twice: Xperience's `tt7441658` (2017, the whole show) in search, and AniList's season-one entry `kitsu:13209` (2017–2021) on the Anime tab, with its own title page. Swapping posters alone (#106's "Posters for Anime", then `3959beb`) only covered entries that start their IMDb title. In AniList's top 500 Popular that left 155 on AniList's covers: later seasons (Reincarnated as a Sword 2, The Apothecary Diaries 3, Cyberpunk: Edgerunners 2), second cours and films. The user asked for the tab to "follow Xperience", one card per show.

## Decision

When a profile has a poster addon chosen (`ProfileSettings.animePosterAddon`, now labelled "Anime titles"), AniList still picks what the Anime tab lists and in what order. Each entry, though, shows as the IMDb title it belongs to. The card carries the addon's poster, name and year, and opens the `tt…` title page that search opens, with the addon's details and seasons. A show's seasons and cours fold into one card, at the first one's place. A card that got onto the list through a later season opens on that season (`?season=N`, only for N > 1, so the title page's own pick stands otherwise). With no addon chosen ("AniList"), the tab is AniList's entries as before.

`animelist.Service.Titles(ids)` decides, from Fribb's list. An entry belongs to its IMDb title when it has exactly one IMDb id and is:

- a show's season or cour, any TVDB season but 0 (`series`, with the season), or
- a film whose IMDb id is its own (`movie`). The list's `themoviedb_id` kind decides film or show where it has one. A film that TVDB files as a show's season 0 carries the show's IMDb id, so `MOVIE` alone can't tell.

Specials, OVAs and films filed as a show's season 0 stay AniList's (Naruto Shippuden's films), and so does a film whose IMDb id a show's season also has. On the same top 500, 500 entries become 369 cards, 360 of them IMDb titles.

The frontend (`lib/anime-titles.ts`) maps a page of ids in one batched call and holds a page until it's answered, so seasons never flash as separate cards. Each card asks the addon for its own details as it mounts, with AniList's name and cover standing in until they arrive. The mapping applies to the Anime tab's grid, Home's anime rows, and the anime results of search and the ⌘K palette, where the existing de-duplication by id now merges AniList's result with the addon's. Home's hero carousel keeps AniList's entries and backdrops.

## Consequences

- Followed cards get the addon's (Cinemeta-style) details and IMDb/TVDB seasons, not AniList's synopsis, score and Kitsu episode art. That matches opening the anime from search.
- Streams ask with `tt` ids, as they do for any show. AniList tracking maps `tt` + season back to the entry through `animelist.Find`.
- `kitsu:` items already in the library or Continue watching stay as they are.
- The setting is per device, like every `ProfileSettings` field.
