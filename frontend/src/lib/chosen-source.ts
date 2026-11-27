import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { Service as Store, type ChosenSource } from "@bindings/store";
import type { Candidate, Remembered } from "@/lib/ranking";
import type { Attempt } from "@/lib/resolve";
import { profileKnown } from "@/lib/profile";
import { isSeriesType } from "@/lib/title";

// The source a profile last played a show from (#58, F19): the addon (or
// plugin), quality and release group of the stream that played, kept in the
// Go store per profile and show. The next episode's picker, the player's
// stream switcher and the next-episode card rank its closest match first
// (lib/ranking/remembered.ts); whatever plays next, picked or not, replaces
// it. Films have no next episode, so only series keep one.

export const chosenSourceQuery = (profileId: number, contentId: string) =>
  queryOptions({
    queryKey: ["chosen-source", profileId, contentId],
    queryFn: () => Store.ChosenSource(profileId, contentId),
    staleTime: Number.POSITIVE_INFINITY,
    // The next-episode card and the player's switcher ask this; before the
    // store has named the profile there is nothing to ask (profileKnown).
    enabled: profileKnown(profileId),
  });

// What ranking matches: none for a film, or a show nothing has played from.
export function remembered(chosen: ChosenSource | null | undefined): Remembered | null {
  if (!chosen) return null;
  return {
    source: chosen.source,
    resolution: chosen.resolution || null,
    group: chosen.group || null,
  };
}

// The fingerprint of the copy that played: its own source, and the file's
// quality and group as parsed.
export function chosenFrom(candidate: Candidate, attempt: Attempt, now = Date.now()): ChosenSource {
  return {
    source: attempt.source,
    resolution: candidate.parsed.resolution ?? "",
    group: candidate.parsed.group ?? "",
    chosenAt: now,
  };
}

// Remembers what played for the show, in the store and the query cache.
// Never fails the play: a store that can't save leaves the old one.
export function rememberSource(
  client: QueryClient,
  profileId: number,
  type: string,
  contentId: string,
  candidate: Candidate,
  attempt: Attempt,
) {
  if (!isSeriesType(type)) return;
  const chosen = chosenFrom(candidate, attempt);
  const { queryKey } = chosenSourceQuery(profileId, contentId);
  Store.SetChosenSource(profileId, contentId, chosen).then(
    () => client.setQueryData(queryKey, chosen),
    () => {},
  );
}
