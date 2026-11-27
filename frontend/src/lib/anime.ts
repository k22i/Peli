import { Service as AnimeList } from "@bindings/animelist";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { batcher } from "@/lib/batch";
import { profileKnown } from "@/lib/profile";
import { profileSettingsQuery } from "@/lib/settings";

// Anime out of Movies and Shows (#109, ADR-0045). General catalogs such as
// Cinemeta's list anime under IMDb ids; the anime list (Go's
// internal/animelist) knows which those are, so Movies, Shows, Home's
// general rows and search's Movies and Shows groups leave them to the Anime
// tab. Western animation isn't on the list, so it stays.

// Which IMDb ids are anime is asked of Go a page of results at a time
// (AnimeList.LeaveOut, #128): the full list (about 5,900 ids) never crosses
// the bridge. Answers are kept for the session. Until Go has a copy of the
// list (first run, offline, a phone on mobile data) it says it isn't ready:
// nothing is left out, and the ids are asked again every half minute.

export const notReadyRetryMs = 30_000;

// IMDb id → whether it is anime, from ready answers only.
const known = new Map<string, boolean>();
// Asked, not answered yet.
const asking = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
let retry: ReturnType<typeof setTimeout> | undefined;

const ask = batcher(async (ids: string[]) => {
  const answer = await AnimeList.LeaveOut(ids);
  if (!answer.ready) throw new NotReady();
  return ids.map((_, i) => answer.anime?.[i] ?? false);
});

class NotReady extends Error {}

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function askAgainLater(imdb: string) {
  asking.delete(imdb);
  retry ??= setTimeout(() => {
    retry = undefined;
    // Asking again needs a render to call isAnime: tell the pages.
    changed();
  }, notReadyRetryMs);
}

// Whether the anime list knows imdb as anime: undefined until Go answers,
// and the question is sent (batched with the others of this tick).
function isAnime(imdb: string): boolean | undefined {
  const answer = known.get(imdb);
  if (answer !== undefined || asking.has(imdb)) return answer;
  asking.add(imdb);
  ask(imdb).then(
    (anime) => {
      asking.delete(imdb);
      known.set(imdb, anime);
      changed();
    },
    () => askAgainLater(imdb),
  );
  return undefined;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => version;

// For tests: forget every answer.
export function resetAnimeAnswers() {
  known.clear();
  asking.clear();
  if (retry) clearTimeout(retry);
  retry = undefined;
  changed();
}

// The IMDb id an id names: "tt0388629" for an episode's "tt0388629:1:1".
export const imdbOf = (id: string) => (id.startsWith("tt") ? id.split(":")[0]! : undefined);

// Whether to leave a title of a general catalog out, for the profile: never
// when it keeps anime in Movies and Shows (Settings), else when the anime
// list knows it. A title not answered yet stays in until the answer comes
// (a moment), as every title did while the old id list loaded.
export function useLeaveOutAnime(profileId: number | undefined): (id: string) => boolean {
  const settings = useQuery({
    ...profileSettingsQuery(profileId ?? 0),
    enabled: profileKnown(profileId),
  });
  const keep = settings.data?.animeInMoviesAndShows ?? false;
  const answers = useSyncExternalStore(subscribe, snapshot, snapshot);
  const asks = profileKnown(profileId) && !keep;
  return useCallback(
    (id: string) => {
      const imdb = asks ? imdbOf(id) : undefined;
      return imdb !== undefined && isAnime(imdb) === true;
    },
    // answers: a new function when an answer comes, so pages filter again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asks, answers],
  );
}
