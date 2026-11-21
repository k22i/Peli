import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, type HistoryState } from "@tanstack/react-router";

import { Connection } from "@bindings/syncer";
import type { Track, Watching } from "@bindings/playback";
import type { ProfileSettings } from "@bindings/store";
import { toastManager } from "@/components/ui/toast";
import type { ContentType, Meta, Stream } from "@/lib/addon-protocol";
import { playableQuery, type Download, type Playable } from "@/lib/downloads";
import { loadOptions, Player } from "@/lib/player";
import { isIOS } from "@/lib/platform";
import { currentProfileQuery } from "@/lib/profile";
import { profileSettingsQuery } from "@/lib/settings";
import type { SubtitleTarget } from "@/lib/subtitles";
import { useConnection } from "@/lib/sync";
import {
  isSeriesType,
  playerHeading,
  resumePoint,
  titleParams,
  titlePath,
  titleProgressQuery,
  watchingFor,
} from "@/lib/title";
import type { Source } from "@bindings/streams";

// What to play: a title, an episode of it, and where to pick up.
export type PlayTarget = {
  type: ContentType;
  // The title's id, as addons know it.
  id: string;
  title: string;
  // The episode (or a film's video) to play. A film without one plays its
  // own id.
  videoId?: string | undefined;
  // Where to resume, in milliseconds.
  resumeAt?: number | undefined;
  // Play from the beginning whatever progress is stored ("Play from start").
  startOver?: boolean | undefined;
};

// The stream picker's address (#50): the title, with the video and resume
// point in its search, and the target in history state for its heading.
export const streamsPath = "/streams/$type/$id";

export type StreamsSearch = { video?: string; at?: number };

export function streamsSearch(search: Record<string, unknown>): StreamsSearch {
  const video = search["video"];
  const at = search["at"];
  return {
    ...(typeof video === "string" && video ? { video } : {}),
    ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}

// The id streams are asked for: the episode's, or the film's.
export const streamId = (target: Pick<PlayTarget, "id" | "videoId">) => target.videoId ?? target.id;

// Whether a source is a finished download's file (ADR-0064): its URL is a
// path on this device, and its origin says which download. Such a source is
// never asked for again (no re-resolve, no torrent to release), and takes
// its subtitles and skip markers from disk.
export const isDownloadSource = (source: Pick<Source, "origin"> | undefined) =>
  source?.origin?.startsWith("download:") === true;

// What Play says offline, for a title that isn't downloaded.
export const offlineMessage = "You’re offline. Only downloaded titles play now.";

export type PlayerHistory = NonNullable<HistoryState["player"]>;

// The player's history state (#60): its heading, the source, what its
// progress is kept for and where it resumed (seconds), and, for a stream
// from an addon, the stream and what to ask subtitle addons. The picker's
// pick, its watch party's and a downloaded copy all build it here.
export function playerState({
  heading,
  source,
  watching,
  start,
  stream,
  subtitles,
}: {
  heading: { title: string; episode?: string };
  source: Source;
  watching: Watching;
  start: number;
  stream?: Stream;
  subtitles?: SubtitleTarget;
}): PlayerHistory {
  return {
    ...heading,
    source,
    watching,
    resumedAt: start,
    ...(stream && { stream }),
    ...(subtitles && { subtitles }),
  };
}

// The heading a download gives when the title's details aren't at hand
// (offline): its name, and "S1 · E2 · Episode name" for an episode.
export function downloadHeading(download: Download): { title: string; episode?: string } {
  if (!isSeriesType(download.contentType) || (download.season <= 0 && download.episode <= 0))
    return { title: download.name };
  const code = `S${download.season} · E${download.episode}`;
  return {
    title: download.name,
    episode: download.episodeName ? `${code} · ${download.episodeName}` : code,
  };
}

// Plays a finished download (ADR-0064): its file loads in the profile's
// languages, resuming from the store's progress, keeping progress, watched
// marks and tracking as a stream would (#64): Go saves them locally, and the
// outbox pushes them when Nuvio is reachable. Nothing here waits for the
// network. Returns the history state for /player, to navigate with once the
// player has the file; `at` (seconds) overrides where it starts, as a watch
// party's does.
export async function loadDownloaded({
  client,
  profileId,
  target,
  playable,
  meta,
  settings,
  tracks,
  at,
}: {
  client: QueryClient;
  profileId: number;
  target: PlayTarget;
  playable: Playable;
  meta?: Meta | undefined;
  settings?: ProfileSettings | undefined;
  // The tracks playing now, to keep their languages for this file.
  tracks?: Track[] | undefined;
  at?: number | undefined;
}): Promise<PlayerHistory> {
  const { download } = playable;
  // The store's own progress; if it can't say, where the card said.
  const progress = await client
    .fetchQuery({ ...titleProgressQuery(profileId, target.id), staleTime: 0 })
    .catch(() => undefined);
  let watching = watchingFor(profileId, target, meta, progress ?? []);
  if (!meta && isSeriesType(target.type)) {
    // Without the details, the download names the episode.
    watching = {
      ...watching,
      title: download.episodeName || download.name,
      ...(watching.season == null && download.season > 0 && { season: download.season }),
      ...(watching.episode == null && download.episode > 0 && { episode: download.episode }),
    };
  }
  const start =
    at !== undefined && at >= 0
      ? at
      : target.startOver
        ? 0
        : progress
          ? resumePoint(progress, watching)
          : (target.resumeAt ?? 0) / 1000;
  const prefs =
    settings ?? (await client.fetchQuery(profileSettingsQuery(profileId)).catch(() => undefined));
  await Player.Load(playable.source, loadOptions(start, prefs, tracks ?? [], watching));
  return playerState({
    heading: meta
      ? playerHeading(meta, target.videoId ?? target.id, target.title)
      : downloadHeading(download),
    source: playable.source,
    watching,
    start,
  });
}

// The one way to start playback, so Home's hero and Continue Watching (#42),
// the title page (#45) and the library (#46) don't each decide it. It opens
// the stream picker (#50, ranked by #52); the player (#60, resuming #64)
// takes it from there: launch, a click here, then a stream, keeps "launch to
// playing" within three clicks (#40). A series without an episode opens its
// title page instead, to choose one.
//
// A finished download plays first, before anything is asked of an addon
// (ADR-0064): straight to the player, no picker. Offline, a title that
// isn't downloaded says so in a toast instead of opening a picker that
// would fail.
export function usePlay() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const profile = useQuery(currentProfileQuery).data;
  const offline = useConnection() === Connection.Offline;
  return (target: PlayTarget) => {
    if (!target.videoId && isSeriesType(target.type)) {
      void navigate({ to: titlePath, params: titleParams(target) });
      return;
    }
    const openPicker = () =>
      void navigate({
        to: streamsPath,
        params: { type: target.type, id: target.id },
        search: streamsSearch({ video: target.videoId, at: target.resumeAt }),
        state: (state) => ({ ...state, play: target }),
      });
    if (!profile) return openPicker();
    void client
      .fetchQuery(playableQuery(profile.id, streamId(target)))
      .catch(() => null)
      .then(async (playable) => {
        if (!playable) {
          if (offline) toastManager.add({ title: offlineMessage });
          else openPicker();
          return;
        }
        try {
          const player = await loadDownloaded({ client, profileId: profile.id, target, playable });
          await navigate({
            to: "/player",
            // iOS: the player takes the picker's place, so Back and close
            // land on the title.
            replace: isIOS(),
            state: (state) => ({ ...state, player }),
          });
        } catch {
          toastManager.add({
            type: "error",
            title: `Can’t play ${target.title}`,
            description: "Peli’s player couldn’t start. Try again, or restart Peli.",
          });
        }
      });
  };
}
