import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "@/components/ui/toast";
import { Service as Store, type TitleAdjustments } from "@bindings/store";

export type { TitleAdjustments };

// How a profile plays one title when it isn't its defaults: what the
// player's Picture & sound sheet changed, kept in the Go store per profile
// and title (a show's id for all its episodes), on this device only. Go reads
// it at every load (internal/player/picture.go); the sheet reads it to show
// what plays.

export const titleAdjustmentsQuery = (profileId: number, contentId: string) =>
  queryOptions({
    queryKey: ["title-adjustments", profileId, contentId],
    queryFn: () => Store.TitleAdjustments(profileId, contentId),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const adjustedTitlesQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["title-adjustments", profileId, "count"],
    queryFn: () => Store.AdjustedTitles(profileId),
  });

// The sections a title has of its own; a sheet's Reset removes one.
export type Section = keyof Omit<TitleAdjustments, "changedAt">;

// adjustments with one section replaced, or removed when value is undefined;
// null once none is left.
export function withSection<K extends Section>(
  adjustments: TitleAdjustments | null | undefined,
  section: K,
  value: TitleAdjustments[K] | undefined,
  now = Date.now(),
): TitleAdjustments | null {
  const next: TitleAdjustments = { ...adjustments, changedAt: now };
  if (value === undefined) delete next[section];
  else next[section] = value;
  const left = Object.entries(next).some(([key, each]) => key !== "changedAt" && each != null);
  return left ? next : null;
}

// Saves a title's adjustments, showing them at once and undoing them if the
// store refuses.
export function useSaveTitleAdjustments(profileId: number, contentId: string) {
  const queryClient = useQueryClient();
  const { queryKey } = titleAdjustmentsQuery(profileId, contentId);
  return useMutation({
    mutationFn: (adjustments: TitleAdjustments | null) =>
      Store.SetTitleAdjustments(profileId, contentId, adjustments),
    onMutate: async (adjustments) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TitleAdjustments | null>(queryKey);
      queryClient.setQueryData(queryKey, adjustments);
      return { previous };
    },
    onError: (_error, _adjustments, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? null);
      toastManager.add({ type: "error", title: "Couldn’t keep that for this title" });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: adjustedTitlesQuery(profileId).queryKey }),
  });
}
