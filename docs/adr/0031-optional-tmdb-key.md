---
status: accepted
date: 2026-10-30
---

# An optional TMDB key: the user's own, in the keychain, adding art over the addon's

#47 lets the user add their own TMDB key (F12, P1) so title pages get TMDB's logos, backdrops and cast photos. Without a key nothing changes: pages show what the addons send (ADR-0029). The rules are in `lib/tmdb.ts`, the setting is `components/settings/tmdb-dialog.tsx` under Settings › Integrations, and the cast strip is `components/title/cast-list.tsx`.

## The key

- **The user's own.** Peli ships no TMDB key. The field takes either kind TMDB issues: a v3 API key (sent as `api_key`) or a v4 read access token (a JWT starting `eyJ`, sent as a bearer token). Both work on the v3 API.
- **Checked, then kept in the keychain.** Saving calls TMDB's `/authentication` first. A 401 says the key was refused, and nothing is saved when TMDB can't be reached. Then the key goes to the keychain as `tmdb.api-key` (ADR-0007) through the existing secrets service. On Linux without a Secret Service, the dialog says what to install.
- **In memory only in the webview.** It's read into the `["secrets", "tmdb.api-key"]` query, which is never persisted (`shouldPersistQuery`). It is never part of another query's key, and errors don't include request URLs, since a v3 key is in the query string.
- **Per device, for every profile.** Like the keychain itself. Nuvio's profile settings blob has a `tmdb_settings` entry; Peli neither reads nor writes it, so a key never leaves this computer.
- **Removing it** deletes the keychain item and drops every `["tmdb", …]` answer, so pages go back to the addon's art at once.

## Finding the title on TMDB

Only when an id mapping exists, from the most direct:

1. Cinemeta's `moviedb_id` on the details;
2. a `tmdb:<id>` id (TMDB-based addons);
3. an IMDb id: the title's own `tt…` id, or the details' `imdb_id` (Kitsu has one for the anime it maps). It's looked up with `/find/<imdb>?external_source=imdb_id`, preferring the addon's type (`movie` → films, `series` → TV) and taking the other kind when that's all there is.

A title with none of these, such as an unmapped Kitsu anime, isn't looked up. An IMDb id in the address is looked up at once, beside the addon's details, so TMDB's art usually arrives with them. When the details then give a `moviedb_id`, it names the same TMDB title, so the details are still asked only once.

## What it adds

One request per title: `/movie/<id>?append_to_response=images,credits` or `/tv/<id>?append_to_response=images,aggregate_credits`, with `include_image_language=en,null`.

- **Logo:** English first, then a logo with no text language, then any (`w500`). It replaces the addon's; the Hero falls back to the name if it fails to load.
- **Backdrop:** TMDB's main `backdrop_path` at `original` size. The addon's backdrop shows under it while it loads and if it fails (`Artwork`'s new `fallback`), so the swap never flashes the gradient.
- **Cast:** up to 20 people, with photos (`w185`) and their characters (a series' first role from `aggregate_credits`), in a Cast strip above About. About then leaves out its text Cast row; directors and writers still come from the addon.
- Posters, names, synopses and episodes stay the addon's. A user who picked an addon for its posters (with ratings on them, say) keeps them.

Answers are kept across restarts (`meta.persist`): the IMDb-to-TMDB mapping for 7 days, the details for a day. When TMDB fails, is slow or doesn't know the title, the page is exactly as it is without a key.

## What we give up

- **English art and names only.** Logos prefer English, and characters come in TMDB's default language. A language setting can follow the profile's language later.
- **Title pages only.** Home's hero and the cards keep the addon's art. They could use the same `useTmdbArt` later, but a request per card isn't worth it now.
- **No other ratings.** The ticket's scope is art and cast; TMDB's vote average isn't shown.

## Verification

- **Unit tests** (`lib/tmdb.test.ts`): the id mapping order, picking the logo, backdrop and cast (films and series), the 20-person cap and odd answers, both kinds of key, and the error kinds.
- **Settings tests** (`components/settings/tmdb-dialog.test.tsx`): a refused key isn't saved, a good one is checked then saved and trimmed, TMDB unreachable, a keychain that can't keep it, and removal.
- **Title tests** (`routes/title.test.tsx`): no key means no TMDB request and the text cast; with a key, TMDB's logo, backdrop (with the addon's under it) and cast photos; a Kitsu anime found by its `imdb_id`; and TMDB failing leaves the addon's details.
- **Not checked live:** there was no TMDB key to test with. TMDB's API answers with `Access-Control-Allow-Origin: *` (checked with curl, including the preflight for `Authorization`), so the webview can call it without the Go fallback the addon client has.
