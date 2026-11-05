import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { ProfileSettings } from "@bindings/store";
import { streamsQuery, type Meta } from "@/lib/addon-protocol";
import { chosenSourceQuery, remembered } from "@/lib/chosen-source";
import { useEpisodeMap } from "@/lib/episode-map";
import { useLoadedAddons } from "@/lib/home";
import { titleContext, type Candidate } from "@/lib/ranking";
import { attempts, resolvePick, type Resolved } from "@/lib/resolve";
import { deviceSettingsQuery } from "@/lib/settings";
import { rankingPrefs, useRankedStreams, useStreamAddons, useStreams } from "@/lib/streams";
import { episodes, mainEpisodes, type Episode } from "@/lib/title";

// The next episode (#65, F22): once the episode playing counts as watched
// (90 %, as Go marks it, #64), a card offers the next one and counts down
// to the end of the file, when it plays. Its streams are asked for and
// ranked as the card shows, and the top pick's link resolved, so Play now
// starts at once. Torrents wait until it plays: opening one stops the torrent
// playing (internal/torrent plays one at a time), and starts peer traffic
// for an episode the user may cancel.

// The episode after videoId: the next one out, in order, outside Specials
// (as Play on the title page goes). None after the last, for a special, or
// for a film.
export function nextEpisode(meta: Meta, videoId: string, now = Date.now()): Episode | undefined {
  const list = mainEpisodes(episodes(meta), now);
  const index = list.findIndex((episode) => episode.id === videoId);
  return index < 0 ? undefined : list[index + 1];
}

// Where the countdown starts, in seconds: where the file counts as watched,
// 90 % of at least a minute (internal/watching), or where its credits start
// when that's later (#69), so the card doesn't cover the last scene. Never
// before the watched mark: Play now would leave the episode unwatched. None
// for a shorter file or one of unknown length.
export function countdownFrom(duration: number, credits?: number): number | undefined {
  if (duration < 60) return undefined;
  const watched = duration * 0.9;
  return credits !== undefined && credits > watched && credits < duration ? credits : watched;
}

// Asking, ranked and ready to play, or no stream to play. A ready one
// without `resolved` is a torrent, resolved when it plays. `names` are the
// stream addons' names, by URL.
export type PreparedNext =
  | { status: "finding" }
  | {
      status: "ready";
      candidate: Candidate;
      resolved?: Resolved;
      names: ReadonlyMap<string, string>;
    }
  | { status: "none" };

// How long the ranking stays the same, once every addon has answered,
// before its top pick is taken.
const settleAfter = 500;

// Gets the next episode ready while mounted: its streams from every stream
// addon, ranked as the picker ranks them, and the top pick resolved. Leaving
// aborts what's still out. The top pick is the closest match to the source
// the show last played from (#58), as in the picker, so the pick waits for
// the store to say what that was.
export function usePreparedNext(
  profileId: number,
  meta: Meta,
  next: Episode,
  settings: ProfileSettings | undefined,
): PreparedNext {
  const client = useQueryClient();
  const { addons, loading } = useStreamAddons(profileId);
  const sources = useStreams(addons, meta.type, next.id);
  const chosen = useQuery(chosenSourceQuery(profileId, meta.id));
  const device = useQuery(deviceSettingsQuery).data;
  const browsing = useLoadedAddons(profileId);
  const map = useEpisodeMap(browsing.addons, browsing.loading, meta.type, meta.id, next.id);
  const ctx = titleContext(meta.type, next.id, meta, meta.name, map);
  const { view } = useRankedStreams(
    sources,
    ctx,
    rankingPrefs(settings, device, remembered(chosen.data)),
  );
  const answered =
    !loading && !chosen.isPending && sources.every((source) => source.status !== "pending");

  // The top pick once the ranking settles, null for none.
  const [top, setTop] = useState<Candidate | null>();
  useEffect(() => {
    if (!answered || top !== undefined) return undefined;
    const timer = setTimeout(() => setTop(view.top), settleAfter);
    return () => clearTimeout(timer);
  }, [answered, view, top]);

  // Only copies with a link resolve in advance.
  const linked = top ? attempts(top).some(({ stream }) => stream.url) : false;
  const torrents = top ? attempts(top).some(({ stream }) => !stream.url && stream.infoHash) : false;
  const [outcome, setOutcome] = useState<{ resolved?: Resolved; failed?: boolean }>();
  useEffect(() => {
    if (!top || !linked) return undefined;
    const controller = new AbortController();
    resolvePick(top, {
      refresh: async (source) =>
        (await client.fetchQuery({ ...streamsQuery(source, meta.type, next.id), staleTime: 0 }))
          .streams,
      // Copies without a link wait, as the pick would.
      openTorrent: () => Promise.reject(new Error("later")),
      signal: controller.signal,
    }).then(
      (resolved) => setOutcome({ resolved }),
      () => {
        if (controller.signal.aborted) return;
        // A torrent copy may still play; it opens then.
        setOutcome(torrents ? {} : { failed: true });
      },
    );
    return () => controller.abort();
  }, [top, linked, torrents, client, meta.type, next.id]);

  if (top === null || outcome?.failed) return { status: "none" };
  if (!top || (linked && !outcome)) return { status: "finding" };
  return {
    status: "ready",
    candidate: top,
    ...(outcome?.resolved && { resolved: outcome.resolved }),
    names: new Map(addons.map((addon) => [addon.url, addon.manifest.name])),
  };
}
