import { Service as AnimeList } from "@bindings/animelist";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { profileSettingsQuery } from "@/lib/settings";

// Anime out of Movies and Shows (#109, ADR-0045). General catalogs such as
// Cinemeta's list anime under IMDb ids; the anime list (Go's
// internal/animelist) knows which those are, so Movies, Shows, Home's
// general rows and search's Movies and Shows groups leave them to the Anime
// tab. Western animation isn't on the list, so it stays.

// The IMDb ids the anime list knows. Until Go has a copy of the list (first
// run, offline) it says it isn't ready, nothing is left out, and it's asked
// again every half minute.
export const animeIdsQuery = queryOptions({
  queryKey: ["anime-ids"],
  queryFn: () => AnimeList.IMDbIDs(),
  staleTime: 24 * 60 * 60 * 1000,
  refetchInterval: (query) => (query.state.data?.ready === false ? 30_000 : false),
  select: (answer) => new Set(answer.imdb ?? []),
});

// The IMDb id an id names: "tt0388629" for an episode's "tt0388629:1:1".
export const imdbOf = (id: string) => (id.startsWith("tt") ? id.split(":")[0]! : undefined);

// Whether the anime list knows id as anime.
export function isListedAnime(ids: ReadonlySet<string> | undefined, id: string): boolean {
  const imdb = imdbOf(id);
  return imdb !== undefined && ids !== undefined && ids.has(imdb);
}

// Whether to leave a title of a general catalog out, for the profile: never
// when it keeps anime in Movies and Shows (Settings), else when the anime
// list knows it.
export function useLeaveOutAnime(profileId: number | undefined): (id: string) => boolean {
  const settings = useQuery({
    ...profileSettingsQuery(profileId ?? 0),
    enabled: profileId !== undefined,
  });
  const keep = settings.data?.animeInMoviesAndShows ?? false;
  const ids = useQuery({ ...animeIdsQuery, enabled: profileId !== undefined && !keep }).data;
  return useCallback((id: string) => !keep && isListedAnime(ids, id), [keep, ids]);
}
