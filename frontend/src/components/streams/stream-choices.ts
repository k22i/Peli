import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { listRows } from "@/components/streams/stream-list";
import type { Filtering } from "@/components/streams/stream-toolbar";
import { streamsQuery, type ContentType, type Stream } from "@/lib/addon-protocol";
import { chosenSourceQuery, remembered } from "@/lib/chosen-source";
import { useEpisodeMap } from "@/lib/episode-map";
import { useLoadedAddons } from "@/lib/home";
import { isPluginSource, pluginSource, pluginStreamsQuery } from "@/lib/plugins";
import { rememberedMatch, titleContext, type Candidate, type Tier } from "@/lib/ranking";
import {
  audioLanguagesOf,
  deviceSettingsQuery,
  languageName,
  profileSettingsQuery,
  useSaveDeviceSettings,
} from "@/lib/settings";
import {
  facetChips,
  filtersKey,
  filtersLabel,
  filterView,
  isFiltered,
  isStreamSort,
  keepForSession,
  offered,
  sessionFilters,
  sortsAvailable,
  toggle,
  type StreamFilters,
  type StreamSort,
} from "@/lib/stream-filters";
import {
  rankingPrefs,
  usePluginSources,
  useRankedStreams,
  useStreamAddons,
  useStreams,
} from "@/lib/streams";
import { tmdbRef, useTmdbAliases } from "@/lib/tmdb";
import { cachedTitleMeta, isSeriesType, titleMetaQuery } from "@/lib/title";

// The ranked streams for one film or episode, as the picker and the
// player's stream switcher (#68) list them, filtered and sorted as the user
// chose (`filtering`, `sourceFilter`): every stream addon asked, and
// their streams ranked as they answer, by what the title's details (as its
// page asked for them, usually cached by now) and the profile's audio
// language say. Ranking starts without the details and starts again once
// they come. The source a show last played from (#58) puts its closest
// match on top, which `usual` tells. `rows` has the collapsed groups that
// toggleGroup opened.
export function useStreamChoices(
  profileId: number,
  type: ContentType,
  id: string,
  video: string,
  title: string,
) {
  const { addons, loading: addonsLoading } = useStreamAddons(profileId);
  const addonSources = useStreams(addons, type, video);
  const client = useQueryClient();
  const browsing = useLoadedAddons(profileId);
  const metaQuery = useQuery({
    ...titleMetaQuery(browsing.addons, type, id),
    enabled: !browsing.loading,
    ...cachedTitleMeta(client, browsing.addons, type, id),
  });
  const meta = metaQuery.data?.meta;
  // Plugins (#56) are asked beside the addons, and ranked with them.
  const plugins = usePluginSources(type, id, video, meta);
  const sources = [...addonSources, ...plugins.sources];
  const loading = addonsLoading || plugins.loading;
  const names = new Map(sources.map((source) => [source.key, source.name]));
  // A fresh answer from the source of an expired link (#53): its addon, or
  // its plugin.
  const refresh = async (source: string): Promise<readonly Stream[]> => {
    if (isPluginSource(source)) {
      const plugin = plugins.plugins.find((p) => pluginSource(p) === source);
      if (!plugin || !plugins.query) return [];
      return client.fetchQuery({ ...pluginStreamsQuery(plugin, plugins.query), staleTime: 0 });
    }
    return (await client.fetchQuery({ ...streamsQuery(source, type, video), staleTime: 0 }))
      .streams;
  };
  const settings = useQuery(profileSettingsQuery(profileId)).data;
  const device = useQuery(deviceSettingsQuery).data;
  const chosenQuery = useQuery({
    ...chosenSourceQuery(profileId, id),
    enabled: isSeriesType(type),
  });
  const chosen = chosenQuery.data;
  const last = isSeriesType(type) ? remembered(chosen) : null;
  const { map, pending: mapPending } = useEpisodeMap(
    browsing.addons,
    browsing.loading,
    type,
    id,
    video,
  );
  // TMDB's other names for the title, from the title page's own request (#99).
  const aliases = useTmdbAliases(tmdbRef(type, id, meta));
  const ctx = titleContext(type, video, meta, title, { map, aliases });
  const prefs = rankingPrefs(settings, device, last);
  const { view: ranked, pin: pinRanked } = useRankedStreams(sources, ctx, prefs);

  // The filters and the sort (the sort is the device's, the filters the
  // session's), applied to the ranked view before its rows are listed.
  const [filters, setFiltersState] = useState<StreamFilters>(sessionFilters);
  const setFilters = (next: StreamFilters) => {
    keepForSession(next);
    setFiltersState(next);
  };
  const saveDevice = useSaveDeviceSettings();
  const candidates = useMemo(() => offered(ranked), [ranked]);
  const sorts = sortsAvailable(candidates);
  const saved: StreamSort = isStreamSort(device?.streamSort) ? device.streamSort : "best";
  const sort = sorts.includes(saved) ? saved : "best";
  const setSort = (next: StreamSort) => {
    if (device) saveDevice.mutate({ ...device, streamSort: next });
  };
  // A top pick the user pinned under each set of filters.
  const [pins, setPins] = useState<ReadonlyMap<string, string>>(new Map());
  const key = filtersKey(filters);
  const pinned = pins.get(key) ?? null;
  const maxResolution = prefs.maxResolution;
  const view = filterView(ranked, filters, sort, { remembered: last, maxResolution, pinned });
  const pin = () => {
    pinRanked();
    const top = view.top;
    if (!isFiltered(filters) || !top) return;
    setPins((current) => (current.has(key) ? current : new Map(current).set(key, top.key)));
  };
  const chipContext = { languages: audioLanguagesOf(settings), languageName, names };
  const chips = facetChips(candidates, filters, chipContext);
  const filtering: Filtering = {
    filters,
    setFilters,
    chips,
    sort,
    sorts,
    setSort,
    label: filtersLabel(filters, chipContext),
  };
  const sourceChips = chips.find((chip) => chip.facet === "source");
  const sourceFilter: SourceFilter | undefined = sourceChips && {
    chosen: filters.chosen.source ?? [],
    toggle: (source) => setFilters(toggle(filters, "source", source)),
  };

  const [open, setOpen] = useState<ReadonlySet<Tier>>(new Set());
  const toggleGroup = (tier: Tier) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(tier)) next.add(tier);
      return next;
    });
  // Every source has answered, and what ranks them has loaded: the top
  // pick only changes now if the user moves it.
  const answered =
    !loading &&
    sources.every((source) => source.status !== "pending") &&
    !browsing.loading &&
    !metaQuery.isPending &&
    !mapPending &&
    !(isSeriesType(type) && chosenQuery.isPending) &&
    device !== undefined;
  return {
    loading,
    answered,
    sources,
    names,
    meta,
    settings,
    device,
    // Filtered and sorted; `ranked` is the ranking's own.
    view,
    ranked,
    pin,
    rows: listRows(view, open),
    toggleGroup,
    refresh,
    usual: (candidate: Candidate) => !!last && rememberedMatch(last, candidate) > 0,
    filtering,
    sourceFilter,
  };
}

// The addon chips as filters: which are chosen, and choosing one.
export type SourceFilter = {
  chosen: readonly string[];
  toggle: (source: string) => void;
};
