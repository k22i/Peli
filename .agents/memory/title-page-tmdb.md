---
name: title-page-tmdb
description: "Title page extras from TMDB: crew in About via PersonLink, certificate + TMDB score in the meta line, Trailer round action (system browser), Part of the X Collection and More Like This rows, how TMDB ids open in Peli"
metadata:
  type: project
---

The one details request (`tmdbDetailsQuery`, key suffix `"page"`, retires the `"aliases"` answers) now also appends `release_dates` (film) / `content_ratings` (series), `videos`, `recommendations`, `similar`, plus `include_video_language=en,null`. `parseTmdbArt(answer, region?)` returns `id`, `crew: CrewGroup[]` (Created by / Directed by / Written by / Music by, ≤5 people each, deduped by id), `certificate`, `networks`, `studios` (≤3), `score` (needs votes), `trailer` (YouTube watch URL), `related` (≤20, recommendations else similar) and `collection`. Aliases and ranking are untouched.

**Why:** the title page showed only addon text plus cast; TMDB has the rest in the same request, so no extra calls except `/collection/{id}` (`useTmdbCollection`, persisted, film only) and one `external_ids` call per opened suggestion.

**How to apply:**
- Region for the certificate: `navigator.language`'s region, else US; the app has no region setting. Film: theatrical (type 3) certification first. The cache key has no region, fine while the system language is stable.
- Opening a suggestion: Cinemeta doesn't answer `tmdb:<id>`, so `related-rows.tsx` asks `/{media}/{id}/external_ids` on click (`tmdbImdbQuery`, kept 30 days) and opens `/title/<movie|series>/<tt…>` with the card as preview; no IMDb id gives an error toast. Batching up front would be 20 requests for rows nobody opens.
- Kids profiles get no trailer, no collection, no More Like This (TMDB's lists ignore the addon allow-list). The certificate, score and crew still show.
- Names go through `PersonLink` (`components/title/person-link.tsx`, plain span with `data-person-id`): About and CastList use it; swap it for a link there once people have pages.
- About takes `art`; TMDB crew replaces the addon's "Directed by"/"Written by" when TMDB has any crew. Network/Studio rows are new.
- Trailer is a `RoundAction` calling `Browser.OpenURL` (Wails); the player is not involved. Route tests mock `@wailsio/runtime` with `importOriginal` spread + `Browser`; the real runtime then calls `fetch` with URL objects, so `serve()` in `title.test.tsx` stringifies its input.
- The collection row marks the open film "This film" (`aria-current`). Row hides unless ≥2 films.
- Not checked: a real-window look or screenshot; the full suite already fails 59–131 tests on this branch before these changes (stale bindings / "Main" nav not found), and title.test.tsx is flaky under load on a clean checkout.
- Related: [[title-page-redesign]], [[tmdb-key]], [[title-matching]], [[kids-profiles]].
