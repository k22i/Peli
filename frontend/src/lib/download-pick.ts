import { useQuery } from "@tanstack/react-query";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import type { Download } from "@bindings/store";
import { toastManager } from "@/components/ui/toast";
import type { Meta, Video } from "@/lib/addon-protocol";
import { chosenSourceQuery, remembered } from "@/lib/chosen-source";
import {
  addRequestFor,
  downloadFor,
  downloadable,
  statusOf,
  statusText,
  subtitleRefs,
  useDownloadActions,
  useDownloads,
  type AddRequest,
  type DownloadActions,
} from "@/lib/downloads";
import { useEpisodeMap } from "@/lib/episode-map";
import { useLoadedAddons } from "@/lib/home";
import { settleAfter } from "@/lib/pre-resolve";
import { titleContext, type Candidate, type RankedView } from "@/lib/ranking";
import { deviceSettingsQuery, profileSettingsQuery } from "@/lib/settings";
import { rankingPrefs, useRankedStreams, useStreamAddons, useStreams } from "@/lib/streams";
import { byLanguage, subtitleLanguage, subtitleTarget, useAddonSubtitles } from "@/lib/subtitles";
import type { Episode } from "@/lib/title";
import { tmdbRef, useTmdbAliases } from "@/lib/tmdb";

// Downloading from wherever a title shows (#85, part 6; ADR-0064): the title
// page, an episode's or a season's menu, a card's menu and a stream's row.
// The stream is the one the next-episode preparation would play
// (lib/next-episode): every stream addon asked, ranked with the show's
// remembered source (ADR-0044) and the profile's stream preferences
// (ADR-0048), and the best pick taken — except that a copy with no link can
// never be downloaded (the torrent call at the gate), so the best one with a
// link wins. Its subtitles in the profile's language go beside it.
//
// The ranking needs hooks, so an invisible DownloadRunner does it: a control
// queues a film or an episode, the runner mounted beside the control ranks
// its streams and calls Add, then leaves. A season's episodes go through the
// same queue one at a time, never side by side.

// Go saves ten subtitles a download (downloads.Add); two in the profile's
// language are enough to read the file by.
const mostSubtitles = 2;

// --- What to download ---------------------------------------------------------

// One film or episode to download, with what AddRequest needs of the title.
export type DownloadTarget = {
  // The title's details: they name the download and hold the episode list.
  meta: Meta;
  // The episode, or a film's video. None for a film that plays its own id.
  video?: Video | undefined;
  // The addon whose details served meta (a kids profile may download only
  // what its own addons served).
  metaAddon: string;
};

// The id a film or episode's streams are asked for: the video's, or the
// film's own (as the picker asks, lib/playback's streamId).
export const downloadVideoId = (meta: Meta, video?: Video | undefined) =>
  video?.id ?? meta.behaviorHints?.defaultVideoId ?? meta.id;

// The target for one of a title's videos, from the addon its details came
// from.
export function downloadTarget(meta: Meta, metaAddon: string, video?: Video): DownloadTarget {
  return { meta, video, metaAddon };
}

// The best-ranked stream that can be downloaded: the top pick, then each
// group in order, skipping the copies with no link. Undefined when none of
// them has one (a library of torrents only).
export function topDownloadable(view: RankedView): Candidate | undefined {
  const seen = new Set<string>();
  for (const candidate of [view.top, ...view.groups.flatMap((group) => group.items)]) {
    if (!candidate || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (downloadable(candidate.stream)) return candidate;
  }
  return undefined;
}

// --- What a control says ------------------------------------------------------

export const findingText = "Finding a stream…";

// What a control says when the ranking found nothing it can download.
export const noStreamText = "No stream to download. Pick one in the stream list.";

// What pressing a download control does.
export type DownloadAction = "download" | "resume" | "remove" | "none";

export type DownloadControl = {
  // The button's name and tooltip: "Download", "Finding a stream…", or the
  // record's own status ("Queued", "Downloading 42 %", "Downloaded").
  label: string;
  action: DownloadAction;
};

// What a Download control shows and does for a video: a record wins over a
// ranking in flight, and a paused, failed or finished download is what
// pressing it acts on.
export function downloadControl(
  download: Download | undefined,
  finding: boolean,
): DownloadControl {
  if (download) {
    const status = statusOf(download);
    return {
      label: statusText(download),
      action:
        status === "paused" || status === "failed"
          ? "resume"
          : status === "done"
            ? "remove"
            : "none",
    };
  }
  return finding
    ? { label: findingText, action: "none" }
    : { label: "Download", action: "download" };
}

// The rows a menu shows for one of a title's videos (#85): the way in, where
// it is, and the way out. `label` names the download a menu offers, so a
// series' card says "Download next episode".
export type DownloadRows = {
  // The row that starts a download, or says it's being ranked (disabled).
  start?: { label: string; disabled: boolean } | undefined;
  // The record's own line, when it has one.
  status?: string | undefined;
  // A paused or failed download can be resumed.
  resume?: boolean | undefined;
  // A record can be removed.
  remove?: boolean | undefined;
};

export function downloadRows(state: DownloadState, label: string): DownloadRows {
  const { download, control } = state;
  if (!download) {
    return control.action === "none"
      ? { start: { label: control.label, disabled: true } }
      : { start: { label, disabled: false } };
  }
  const status = statusOf(download);
  return {
    status: statusText(download),
    resume: status === "paused" || status === "failed",
    remove: true,
  };
}

// --- The queue ----------------------------------------------------------------

// One thing to rank and add.
type Job = { key: string; target: DownloadTarget };

// Everything a title's download controls work with: the profile's records,
// the queue that ranks and adds, and the actions on a record.
export type TitleDownloads = {
  // Unset until the profile loads.
  profileId: number | undefined;
  // The profile's downloads, in the queue's order.
  list: readonly Download[];
  queue: DownloadQueue;
  actions: DownloadActions;
};

// A title page's or a menu's downloads: one queue, the profile's records and
// the actions, for the whole title. A card's menu hosts only the queue
// (useDownloadQueue) and reads the rest while its menu is open, so a screen
// of cards costs nothing.
export function useTitleDownloads(profileId: number | undefined): TitleDownloads {
  return useTitleDownloadsWith(profileId, useDownloadQueue(profileId));
}

// The same for a caller that hosts the queue itself, as a card's menu does:
// the card's menu unmounts with its popup, so the queue lives in the card.
export function useTitleDownloadsWith(
  profileId: number | undefined,
  queue: DownloadQueue,
): TitleDownloads {
  const list = useDownloads(profileId);
  const actions = useDownloadActions(profileId);
  return { profileId, list, queue, actions };
}

// What a title's Download is for: a film itself, or a series' episode Play
// would play. A series with no episode to play has nothing to download.
export function videoToDownload(
  meta: Meta,
  videoId: string | undefined,
  series: boolean,
): { video: Video | undefined; canDownload: boolean } {
  if (!series) {
    const id = meta.behaviorHints?.defaultVideoId ?? meta.id;
    return { video: meta.videos?.find((video) => video.id === id), canDownload: true };
  }
  const video = meta.videos?.find((each) => each.id === videoId);
  return { video, canDownload: video !== undefined };
}

// What a Download control is for one of a title's videos, and what pressing
// it would download.
export type DownloadState = {
  // The record, when the video has one (or one that failed, which Go
  // replaces when it's added again).
  download: Download | undefined;
  // What the control shows.
  control: DownloadControl;
  // The target a download press queues.
  target: DownloadTarget;
};

export function downloadState(
  downloads: TitleDownloads,
  meta: Meta,
  metaAddon: string,
  video?: Video | undefined,
): DownloadState {
  const videoId = downloadVideoId(meta, video);
  const download = downloadFor(downloads.list, videoId);
  return {
    download,
    control: downloadControl(download, downloads.queue.finding(videoId)),
    target: downloadTarget(meta, metaAddon, video),
  };
}

// What pressing a control does, from what it shows. A finished download's
// removal goes to `remove` when a caller asks first, else it goes at once.
export function pressDownload(
  state: DownloadState,
  downloads: TitleDownloads,
  remove?: (download: Download) => void,
): void {
  const { control, download } = state;
  if (control.action === "download") {
    downloads.queue.download(state.target);
    return;
  }
  if (!download) return;
  if (control.action === "resume") {
    void downloads.actions.resume(download.id);
    return;
  }
  if (control.action === "remove") {
    if (remove) remove(download);
    else void downloads.actions.remove([download.id]);
  }
}

// Queues every episode of a season that isn't downloaded or queued yet, one
// after another (the queue ranks them in turn), and says how many, with a
// way to stop the rest. Returns how many it queued.
export function downloadSeason(
  downloads: TitleDownloads,
  meta: Meta,
  metaAddon: string,
  episodes: readonly Episode[],
): number {
  const todo = episodes.filter(
    (episode) =>
      !downloadFor(downloads.list, episode.id) && !downloads.queue.finding(episode.id),
  );
  if (todo.length === 0) return 0;
  downloads.queue.downloadMany(
    todo.map((episode) => downloadTarget(meta, metaAddon, episode)),
  );
  toastManager.add({
    type: "success",
    title: `Downloading ${todo.length} ${todo.length === 1 ? "episode" : "episodes"}`,
    actionProps: { children: "Stop", onClick: downloads.queue.stop },
  });
  return todo.length;
}

// What a control needs to download a film or an episode: the queue it joins,
// what is in it, and the invisible component that does the work.
export type DownloadQueue = {
  // Queue one film or episode: rank its streams, then add the best one.
  download: (target: DownloadTarget) => void;
  // Queue several, in order, one after another.
  downloadMany: (targets: readonly DownloadTarget[]) => void;
  // Drop what is left of the queue; what was added stays.
  stop: () => void;
  // Whether anything is still to do.
  running: boolean;
  // Whether this video's streams are being ranked now ("Finding a stream…").
  finding: (videoId: string | undefined) => boolean;
  // Render once beside the control: the ranking and the fetch. It draws
  // nothing.
  runner: ReactElement | null;
};

// Downloads a title's films and episodes, one at a time, from wherever the
// control is. `profileId` may be unset while the profile loads: the queue
// stays empty until it is known.
export function useDownloadQueue(profileId: number | undefined): DownloadQueue {
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const next = useRef(0);

  const enqueue = useCallback(
    (targets: readonly DownloadTarget[]) => {
      if (profileId === undefined || targets.length === 0) return;
      setJobs((current) => {
        // One job per video: a second press while it runs does nothing.
        const fresh = targets.filter(
          (target) =>
            !current.some(
              (job) =>
                downloadVideoId(job.target.meta, job.target.video) ===
                downloadVideoId(target.meta, target.video),
            ),
        );
        if (fresh.length === 0) return current;
        return [
          ...current,
          ...fresh.map((target) => ({ key: `download-${next.current++}`, target })),
        ];
      });
    },
    [profileId],
  );

  const download = useCallback((target: DownloadTarget) => enqueue([target]), [enqueue]);

  const stop = useCallback(() => setJobs([]), []);

  // A finished job leaves the queue, so the next one mounts.
  const settle = useCallback((key: string) => {
    setJobs((current) => current.filter((job) => job.key !== key));
  }, []);

  const finding = useCallback(
    (videoId: string | undefined) =>
      videoId !== undefined &&
      jobs.some((job) => downloadVideoId(job.target.meta, job.target.video) === videoId),
    [jobs],
  );

  const head = jobs[0];
  const runner =
    head && profileId !== undefined
      ? createElement(DownloadRunner, { key: head.key, job: head, profileId, onDone: settle })
      : null;

  return useMemo(
    () => ({ download, downloadMany: enqueue, stop, running: jobs.length > 0, finding, runner }),
    [download, enqueue, finding, jobs.length, runner, stop],
  );
}

// Ranks one job's streams and hands its best downloadable copy to the adder:
// every stream addon asked, the ranking's pick waited for. Draws nothing; it
// is mounted only while its job runs.
function DownloadRunner({
  job,
  profileId,
  onDone,
}: {
  job: Job;
  profileId: number;
  onDone: (key: string) => void;
}) {
  const { meta, video } = job.target;
  const videoId = downloadVideoId(meta, video);
  const { addons, loading } = useStreamAddons(profileId);
  const sources = useStreams(addons, meta.type, videoId);
  const chosen = useQuery(chosenSourceQuery(profileId, meta.id));
  const device = useQuery(deviceSettingsQuery).data;
  const settings = useQuery(profileSettingsQuery(profileId));
  const browsing = useLoadedAddons(profileId);
  const { map, pending: mapPending } = useEpisodeMap(
    browsing.addons,
    browsing.loading,
    meta.type,
    meta.id,
    videoId,
  );
  const aliases = useTmdbAliases(tmdbRef(meta.type, meta.id, meta));
  const ctx = titleContext(meta.type, videoId, meta, meta.name, { map, aliases });
  const { view } = useRankedStreams(
    sources,
    ctx,
    rankingPrefs(settings.data, device, remembered(chosen.data)),
  );

  // Every addon answered (and what ranks the streams has loaded), as the
  // next episode's pick waits for.
  const answered =
    !loading &&
    !chosen.isPending &&
    !mapPending &&
    sources.every((source) => source.status !== "pending");

  // The pick, once the ranking settles on it.
  const [ranked, setRanked] = useState(false);
  useEffect(() => {
    if (!answered || ranked) return undefined;
    const timer = setTimeout(() => setRanked(true), settleAfter);
    return () => clearTimeout(timer);
  }, [answered, ranked]);
  const candidate = ranked ? topDownloadable(view) : undefined;

  // Nothing to download: say so, and let the queue move on to the next one.
  const [told, setTold] = useState(false);
  useEffect(() => {
    if (told || !ranked || candidate) return undefined;
    setTold(true);
    toastManager.add({ type: "error", title: noStreamText });
    onDone(job.key);
  }, [candidate, job.key, onDone, ranked, told]);

  return candidate
    ? createElement(DownloadAdder, {
        key: job.key,
        profileId,
        target: job.target,
        candidate,
        addonName: addons.find((addon) => addon.url === candidate.source)?.manifest.name ?? "",
        onDone: () => onDone(job.key),
      })
    : null;
}

// Adds one stream to the profile's downloads: its subtitles in the profile's
// language beside it, then Add. Draws nothing; it is mounted only while the
// Add is out.
function DownloadAdder({
  profileId,
  target,
  candidate,
  addonName,
  onDone,
}: {
  profileId: number;
  target: DownloadTarget;
  candidate: Candidate;
  // The addon that sent the stream, for the stream's own subtitles.
  addonName: string;
  onDone: () => void;
}) {
  const { meta, video, metaAddon } = target;
  const videoId = downloadVideoId(meta, video);
  const settings = useQuery(profileSettingsQuery(profileId));
  const language = settings.data?.subtitleLanguage ?? "";
  const subtitles = useAddonSubtitles(
    profileId,
    subtitleTarget(meta.type, videoId, candidate.stream, addonName),
  );
  // At most two in the profile's language, in the addons' order (the best
  // match first).
  const picks = useMemo(() => {
    const want = subtitleLanguage(language).code;
    if (!want) return [];
    const group = byLanguage(subtitles.subtitles, language)[0];
    return (group?.subtitles ?? [])
      .filter((subtitle) => subtitle.code === want)
      .slice(0, mostSubtitles);
  }, [language, subtitles.subtitles]);
  // Once the profile's language is known and its subtitles have answered (or
  // there are none to have): Go fetches the file.
  const loaded =
    !settings.isPending &&
    (subtitleLanguage(language).code === "" || !subtitles.loading);
  const request = useMemo<AddRequest>(
    () =>
      addRequestFor({
        profileId,
        meta,
        video,
        metaAddon,
        candidate,
        subtitles: subtitleRefs(picks, language),
      }),
    [candidate, language, meta, metaAddon, picks, profileId, video],
  );
  const actions = useDownloadActions(profileId);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (sent || !loaded) return undefined;
    setSent(true);
    void actions.add(request).then(onDone);
  }, [actions, loaded, onDone, request, sent]);

  return null;
}

// Downloads one stream the user picked (#85): the picker's row menu has the
// candidate already, so nothing is ranked, and the same subtitles go beside
// it. `list` is the profile's downloads, to tell a stream it already has.
export type StreamDownloads = {
  // Whether this very stream is downloaded (the same video, the same link).
  has: (candidate: Candidate) => boolean;
  // Download this stream.
  save: (candidate: Candidate) => void;
  // Whether its Add is out.
  saving: boolean;
  // Render once beside the rows: the subtitles and the Add.
  runner: ReactElement | null;
};

export function useStreamDownloads(
  profileId: number | undefined,
  target: DownloadTarget | undefined,
  list: readonly Download[],
): StreamDownloads {
  const [picked, setPicked] = useState<Candidate | null>(null);
  const videoId = target ? downloadVideoId(target.meta, target.video) : undefined;
  const save = useCallback((candidate: Candidate) => setPicked(candidate), []);
  const has = useCallback(
    (candidate: Candidate) =>
      videoId !== undefined &&
      list.some(
        (download) =>
          download.videoId === videoId &&
          download.request.url === (candidate.stream.url ?? ""),
      ),
    [list, videoId],
  );
  const done = useCallback(() => setPicked(null), []);
  const runner =
    picked && target && profileId !== undefined
      ? createElement(DownloadAdder, {
          key: picked.key,
          profileId,
          target,
          candidate: picked,
          addonName: "",
          onDone: done,
        })
      : null;
  return useMemo(
    () => ({ has, save, saving: picked !== null, runner }),
    [has, picked, runner, save],
  );
}

