import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  addonsFor,
  manifestQuery,
  streamsQuery,
  type ContentType,
  type LoadedAddon,
  type Meta,
  type Stream,
} from "@/lib/addon-protocol";
import type { DeviceSettings, ProfileSettings } from "@bindings/store";
import { addonsQuery } from "@/lib/addons";
import { feature } from "@/lib/features";
import { pluginSource, usePluginStreams, usePluginTargets } from "@/lib/plugins";
import {
  RankingSession,
  emptyView,
  type Prefs,
  type RankedView,
  type Remembered,
  type TitleContext,
} from "@/lib/ranking";
import { audioLanguagesOf, displayModeOf, maxResolutionOf } from "@/lib/settings";

// Streams for the picker (#50): every addon that serves streams for the
// video, asked at once, each with its own state, and their answers handed on
// as they arrive, in slices the ranking engine (#51) can take one at a time
// (ADR-0034). Stream URLs can embed the user's debrid key: never log them.

// The addons a profile asks for streams: every enabled one whose manifest
// loaded, in the user's order. Not VisibleAddons: streams aren't limited for a
// kids profile, since the title came from a catalog it may see (ADR-0014).
// Each addon is there as soon as its own manifest loads, so a slow manifest
// doesn't hold the others back; `loading` is true until every one has.
export function useStreamAddons(profileId: number) {
  const installed = useQuery(addonsQuery(profileId));
  const enabled = (installed.data ?? []).filter((addon) => addon.enabled);
  const manifests = useQueries({ queries: enabled.map((addon) => manifestQuery(addon.url)) });
  const addons: LoadedAddon[] = enabled.flatMap((addon, index) => {
    const manifest = manifests[index]?.data;
    return manifest ? [{ url: addon.url, manifest }] : [];
  });
  return {
    addons,
    loading: installed.isPending || manifests.some((query) => query.isPending),
  };
}

// One addon's or plugin's part in a stream search: asking, answered or
// failed. `key` is what ranking knows it by (the addon's URL, or
// pluginSource), `name` what the picker calls it. `error` is an AddonError
// when the addon was reached, timed out or answered badly, or a PluginError
// (#56); its message is for the user and never names the URL.
export type StreamSource = {
  key: string;
  name: string;
  kind: "addon" | "plugin";
  status: "pending" | "success" | "error";
  streams: readonly Stream[] | undefined;
  error: Error | null;
  retry: () => void;
};

// Asks every addon in `addons` that serves streams for `id` (a film's id, or
// an episode's video id) at once, and gives each one's state in addon order.
// Each addon is its own streamsQuery, so its answer shows as soon as it
// comes, a slow one only holds back itself, and its 30 s timeout is the
// client's. The queries take TanStack Query's signal: once nothing shows them,
// such as when the picker is left, requests still in flight are aborted.
export function useStreams(addons: readonly LoadedAddon[], type: ContentType, id: string) {
  const asked = addonsFor(addons, "stream", type, id);
  const results = useQueries({
    queries: asked.map((addon) => streamsQuery(addon.url, type, id)),
  });
  return asked.map((addon, index): StreamSource => {
    const result = results[index]!;
    return {
      key: addon.url,
      name: addon.manifest.name,
      kind: "addon",
      status: result.status,
      streams: result.data?.streams,
      error: result.error,
      retry: () => void result.refetch(),
    };
  });
}

// Asks every installed plugin that serves the title (#56) for the video's
// streams, as useStreams asks addons: at once, each with its own state.
// None until the title's TMDB id is known; `loading` is true until then.
export function usePluginSources(
  type: ContentType,
  id: string,
  video: string,
  meta: Meta | undefined,
) {
  const { plugins, query, loading } = usePluginTargets(type, id, video, meta);
  const results = usePluginStreams(plugins, query);
  const sources = (query ? plugins : []).map((plugin, index): StreamSource => {
    const result = results[index]!;
    return {
      key: pluginSource(plugin),
      name: plugin.name,
      kind: "plugin",
      status: result.status,
      streams: result.data,
      error: result.error,
      retry: () => void result.refetch(),
    };
  });
  return { sources, loading, plugins, query };
}

// The most streams handed on at once. Comet alone can send ~1,400 for a
// popular title (#6); ranking a slice this size fits in a frame.
export const sliceSize = 150;

// Part of one source's answer, by its key (an addon's URL, a plugin's
// source).
export type StreamSlice = { source: string; streams: readonly Stream[] };

export function slices(streams: readonly Stream[], size = sliceSize): (readonly Stream[])[] {
  const out: Stream[][] = [];
  for (let start = 0; start < streams.length; start += size) {
    out.push(streams.slice(start, start + size));
  }
  return out;
}

// Hands each source's answer on once, in the order they arrive, cut into
// slices. A source that answers again (a refetch) isn't handed on twice; one
// that failed is, once a retry answers.
export class StreamFeed {
  readonly #fed = new Set<string>();

  take(sources: readonly StreamSource[]): StreamSlice[] {
    const out: StreamSlice[] = [];
    for (const { key, status, streams } of sources) {
      if (status !== "success" || !streams || this.#fed.has(key)) continue;
      this.#fed.add(key);
      // A torrent with no link can't play on iOS (ADR-0055): it isn't offered.
      const playable = feature("torrent")
        ? streams
        : streams.filter((stream) => stream.url || !stream.infoHash);
      for (const slice of slices(playable)) out.push({ source: key, streams: slice });
    }
    return out;
  }
}

// Calls `onSlice` with each new slice once its addon answers. One feed per
// mount: key the component by the video, so another video starts afresh.
export function useStreamFeed(
  sources: readonly StreamSource[],
  onSlice: (slice: StreamSlice) => void,
) {
  const feed = useRef<StreamFeed>(null);
  feed.current ??= new StreamFeed();
  useEffect(() => {
    for (const slice of feed.current!.take(sources)) onSlice(slice);
  });
}

// What ranking prefers: the profile's audio language, and HDR when the
// display shows it, and the show's remembered source (#58) as the top pick.
// What ranking needs from the settings (#98, ADR-0048). The device's say what
// it can show: no resolution cap unless one is set (the screen's size is no
// guide, a 4K encode looks better on a 1440p panel too), HDR as the display
// reports `(dynamic-range: high)` unless it is turned On or Off, and Dolby
// Vision off unless it is turned On, since a webview can't see it and the
// player doesn't report it. The profile's say which audio languages come
// first. Settings that haven't loaded yet count as their defaults; when they
// arrive, `useRankedStreams` ranks again.
export function rankingPrefs(
  settings: ProfileSettings | undefined,
  device: DeviceSettings | undefined,
  remembered: Remembered | null = null,
): Prefs {
  const hdr = displayModeOf(device?.hdr);
  const cap = maxResolutionOf(device);
  return {
    languages: audioLanguagesOf(settings),
    maxResolution: cap === "auto" ? "2160p" : cap,
    hdr: hdr === "auto" ? displayShowsHdr() : hdr === "on",
    dolbyVision: displayModeOf(device?.dolbyVision) === "on",
    remembered,
  };
}

const displayShowsHdr = () =>
  typeof matchMedia === "function" && matchMedia("(dynamic-range: high)").matches;

// The streams ranked (#51): every slice from `sources` goes to the ranking
// engine, in the worker, and the ranked view comes back after each. Ranking
// starts at once with what's known; when `ctx` or `prefs` change (the
// title's details or the profile's settings arrive), it starts again with
// every slice so far, keeping a pin. `pin` keeps the top pick where it is
// once the user starts navigating. One session per mount: key the component
// by the video.
export function useRankedStreams(
  sources: readonly StreamSource[],
  ctx: TitleContext,
  prefs: Prefs,
) {
  const [view, setView] = useState<RankedView>(emptyView);
  const session = useRef<RankingSession>(null);
  const fed = useRef<StreamSlice[]>([]);
  const pinned = useRef(false);

  // By value: a new object each render is the same session.
  const settings = JSON.stringify([ctx, prefs]);
  useEffect(() => {
    const [context, preferences]: [TitleContext, Prefs] = JSON.parse(settings);
    const ranking = new RankingSession(context, preferences, setView);
    for (const slice of fed.current) ranking.add(slice.source, slice.streams);
    if (pinned.current) ranking.pin();
    session.current = ranking;
    return () => {
      ranking.close();
      session.current = null;
    };
  }, [settings]);

  useStreamFeed(sources, (slice) => {
    fed.current.push(slice);
    session.current?.add(slice.source, slice.streams);
  });

  return {
    view,
    pin: () => {
      pinned.current = true;
      session.current?.pin();
    },
  };
}
