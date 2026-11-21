import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  Service as Downloads,
  type AddRequest,
  type LocalSubtitle,
  type Network,
  type Playable,
  type Progress,
  type Removed,
  type SubtitleRef,
  type Usage,
} from "@bindings/downloads";
import type { Download } from "@bindings/store";
import { toastManager } from "@/components/ui/toast";
import type { Meta, Stream, Video } from "@/lib/addon-protocol";
import { errorCode } from "@/lib/error-code";
import type { PlayTarget } from "@/lib/playback";
import type { Candidate } from "@/lib/ranking";
import { subtitleLanguage, type AddonSubtitle } from "@/lib/subtitles";
import { watchingFor } from "@/lib/title";

// Downloads for offline viewing (#85, ADR-0064): Go (internal/downloads)
// resolves the stream the frontend picked, fetches it into a per-device
// folder and plays the local file before resolving anything. One job runs at
// a time, the queue is the store's records, and what changes comes back as
// downloads:changed (a whole record), downloads:progress (bytes and speed)
// and downloads:removed. The screens below follow those events; this module
// is the one place that knows Go's codes and states.
//
// Everything here is per profile: a download belongs to the profile that
// started it, and a kids profile sees only what its addons served.

export { Downloads };
export type {
  AddRequest,
  Download,
  LocalSubtitle,
  Network,
  Playable,
  Progress,
  Removed,
  SubtitleRef,
  Usage,
};

// Sizes, as the screens show them (lib/bytes, which lib/torrent re-exports).
export { formatBytes } from "@/lib/bytes";

// The events Go sends (downloads.EventChanged and its two neighbours).
export const changedEvent = "downloads:changed";
export const progressEvent = "downloads:progress";
export const removedEvent = "downloads:removed";

// Every download query: a profile's list is ["downloads", <profileId>], and
// the one-off summaries hang off the same root so a screen can refresh them
// together.
export const downloadsRoot = ["downloads"] as const;

export const downloadsKey = (profileId: number | undefined) => ["downloads", profileId] as const;

export const downloadUsageKey = ["downloads", "usage"] as const;
export const downloadNetworkKey = ["downloads", "network"] as const;

const playableRoot = ["downloads", "playable"] as const;

export const playableKey = (profileId: number | undefined, videoId: string) =>
  [...playableRoot, profileId, videoId] as const;

// A profile's downloads in the queue's order (creation order), as the
// profile may see them (kids profiles have theirs filtered).
export const downloadsQuery = (profileId: number | undefined) =>
  queryOptions({
    queryKey: downloadsKey(profileId),
    queryFn: async () => (profileId === undefined ? [] : ((await Downloads.List(profileId)) ?? [])),
    // Nothing to ask until the profile is known.
    enabled: profileId !== undefined,
  });

// What the downloads take on this device, and the room left.
export const downloadUsageQuery = queryOptions({
  queryKey: downloadUsageKey,
  queryFn: () => Downloads.Usage(),
});

// Whether the device is online, and whether the network is the expensive one
// (cellular, a hotspot) that Wi-Fi-only downloads wait for.
export const downloadNetworkQuery = queryOptions({
  queryKey: downloadNetworkKey,
  queryFn: () => Downloads.Network(),
});

// A finished download of a video, with its file, subtitles and markers, or
// null: asked before anything is resolved, so a downloaded copy always plays.
// Never kept stale: a download may finish while the picker shows.
export const playableQuery = (profileId: number | undefined, videoId: string) =>
  queryOptions({
    queryKey: playableKey(profileId, videoId),
    queryFn: async (): Promise<Playable | null> =>
      profileId === undefined ? null : await Downloads.Playable(profileId, videoId),
    staleTime: 0,
  });

// The profile's downloads, empty until Go answers (or with no profile).
export function useDownloads(profileId: number | undefined): Download[] {
  return useQuery(downloadsQuery(profileId)).data ?? [];
}

// The download of a video from a list: the newest record for it, as Go keeps
// one per (profile, video) unless it failed and was added again.
export const downloadFor = (list: readonly Download[], videoId: string | undefined) =>
  videoId === undefined ? undefined : list.findLast((download) => download.videoId === videoId);

// The one download of a video, or undefined when it has none.
export function useDownload(
  profileId: number | undefined,
  videoId: string | undefined,
): Download | undefined {
  return downloadFor(useDownloads(profileId), videoId);
}

export function useDownloadUsage(): Usage | undefined {
  return useQuery(downloadUsageQuery).data;
}

export function usePlayable(profileId: number | undefined, videoId: string) {
  return useQuery({ ...playableQuery(profileId, videoId), enabled: profileId !== undefined }).data;
}

// --- Speed --------------------------------------------------------------------

// downloads:progress carries the speed, which the records don't hold: kept
// here rather than in the cache so a 500 ms event patches the rows it must
// and re-renders only the speeds.
const rates = new Map<string, number>();
const rateListeners = new Set<() => void>();

function publishRate(id: string, rate: number) {
  if ((rates.get(id) ?? 0) === rate) return;
  if (rate > 0) rates.set(id, rate);
  else rates.delete(id);
  for (const listener of rateListeners) listener();
}

function subscribeRates(listener: () => void): () => void {
  rateListeners.add(listener);
  return () => void rateListeners.delete(listener);
}

// How fast a download runs, in bytes a second, or 0 when it isn't running.
export function useDownloadRate(id: string | undefined): number {
  const read = useCallback(() => (id === undefined ? 0 : (rates.get(id) ?? 0)), [id]);
  return useSyncExternalStore(subscribeRates, read, read);
}

// --- Events -------------------------------------------------------------------

// The lists mounted now, one per profile (["downloads", <profileId>]).
function listCaches(client: QueryClient): { profileId: number; queryKey: QueryKey }[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: downloadsRoot })
    .flatMap((query) => {
      const [, profile] = query.queryKey;
      return typeof profile === "number" ? [{ profileId: profile, queryKey: query.queryKey }] : [];
    });
}

// A record as its list holds it: replaced by id, else added at the end, as a
// new download is the newest and the list is in creation order.
function upsert(list: readonly Download[], download: Download): Download[] {
  const index = list.findIndex((each) => each.id === download.id);
  if (index < 0) return [...list, download];
  const next = [...list];
  next[index] = download;
  return next;
}

function applyChanged(client: QueryClient, download: Download) {
  for (const { profileId, queryKey } of listCaches(client)) {
    if (profileId !== download.profileId) continue;
    client.setQueryData<Download[]>(queryKey, (list) => upsert(list ?? [], download));
  }
  // A job that stopped, finished or failed has no speed to show.
  if (statusOf(download) !== "downloading") publishRate(download.id, 0);
  void client.invalidateQueries({ queryKey: downloadUsageQuery.queryKey });
  void client.invalidateQueries({ queryKey: playableKey(download.profileId, download.videoId) });
}

function applyProgress(client: QueryClient, progress: Progress) {
  publishRate(progress.id, progress.rate);
  for (const { queryKey } of listCaches(client)) {
    client.setQueryData<Download[]>(queryKey, (list) => {
      if (!list) return list;
      let patched = false;
      const next = list.map((download) => {
        if (download.id !== progress.id) return download;
        patched = true;
        // The size is 0 until the server says.
        const total = progress.total > 0 ? progress.total : download.total;
        return { ...download, bytes: progress.bytes, total };
      });
      return patched ? next : list;
    });
  }
}

function applyRemoved(client: QueryClient, ids: readonly string[]) {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  for (const id of ids) publishRate(id, 0);
  for (const { queryKey } of listCaches(client)) {
    client.setQueryData<Download[]>(queryKey, (list) =>
      list?.filter((download) => !gone.has(download.id)),
    );
  }
  void client.invalidateQueries({ queryKey: downloadUsageQuery.queryKey });
  // Which files a playable query would find changed for them all.
  void client.invalidateQueries({ queryKey: playableRoot });
}

// Keeps the download queries in step with Go's events: upserts each changed
// record into its profile's list, patches a running job's bytes there and
// drops what was deleted. **Mount it once** for the whole app (part 9 mounts
// it in the shell, part 7's Library view relies on it): a second copy would
// subscribe twice and patch every list twice.
export function useDownloadEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const offChanged = Events.On(changedEvent, (event) => applyChanged(client, event.data));
    const offProgress = Events.On(progressEvent, (event) => applyProgress(client, event.data));
    const offRemoved = Events.On(removedEvent, (event) =>
      applyRemoved(client, event.data?.ids ?? []),
    );
    return () => {
      offChanged();
      offProgress();
      offRemoved();
    };
  }, [client]);
}

// --- Actions ------------------------------------------------------------------

// What the buttons call: each one a call to Go, with a toast when it's
// refused. The promises resolve either way (the toast has said what
// happened), so "Download season" can add one episode after another.
export type DownloadActions = {
  add: (request: AddRequest) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  remove: (ids: readonly string[]) => Promise<void>;
  removeAll: () => Promise<void>;
};

// A mutation's promise, resolved either way: the toast has said what
// happened, and a caller awaiting several in turn shouldn't stop at one.
const settledPromise = (action: Promise<unknown>): Promise<void> =>
  action.then(
    () => {},
    () => {},
  );

// Toasts a refused call with what the code means.
function failed(error: unknown) {
  toastManager.add({ type: "error", title: downloadErrorText(errorCode(error)) });
}

export function useDownloadActions(profileId: number | undefined): DownloadActions {
  const client = useQueryClient();
  // The event says what changed; this catches the calls that change nothing
  // visible, and the queued order.
  const settled = () => {
    void client.invalidateQueries({ queryKey: downloadsKey(profileId) });
    void client.invalidateQueries({ queryKey: downloadUsageQuery.queryKey });
  };

  const add = useMutation({
    mutationFn: (request: AddRequest) => Downloads.Add(request),
    // What was asked for names itself: Go's answer is the record, but the
    // request's own name is there even when the toast is all a test sees.
    onSuccess: (_download, request) => {
      const label = downloadLabel(request);
      toastManager.add({
        type: "success",
        title: label ? `Downloading ${label}` : "Added to downloads",
      });
    },
    onError: failed,
    onSettled: settled,
  });

  const pause = useMutation({
    mutationFn: async (id: string) => {
      if (profileId === undefined) return;
      await Downloads.Pause(profileId, id);
    },
    onError: failed,
    onSettled: settled,
  });

  const resume = useMutation({
    mutationFn: async (id: string) => {
      if (profileId === undefined) return;
      await Downloads.Resume(profileId, id);
    },
    onError: failed,
    onSettled: settled,
  });

  const remove = useMutation({
    mutationFn: async (ids: readonly string[]) => {
      if (profileId === undefined || ids.length === 0) return;
      await Downloads.Delete(profileId, [...ids]);
    },
    onError: failed,
    onSettled: settled,
  });

  const removeAll = useMutation({
    mutationFn: async () => {
      if (profileId === undefined) return;
      await Downloads.DeleteAll(profileId);
    },
    onError: failed,
    onSettled: settled,
  });

  return {
    add: (request) => settledPromise(add.mutateAsync(request)),
    pause: (id) => settledPromise(pause.mutateAsync(id)),
    resume: (id) => settledPromise(resume.mutateAsync(id)),
    remove: (ids) => settledPromise(remove.mutateAsync(ids)),
    removeAll: () => settledPromise(removeAll.mutateAsync()),
  };
}

// --- States and text ----------------------------------------------------------

// Go's DownloadStates (internal/store): the state a record is in.
export type DownloadStatus = "queued" | "downloading" | "paused" | "waiting" | "failed" | "done";

export function statusOf(download: Pick<Download, "state">): DownloadStatus {
  switch (download.state) {
    case "downloading":
    case "paused":
    case "waiting":
    case "failed":
    case "done":
      return download.state;
    default:
      return "queued";
  }
}

// How far along, 0 to 100, or undefined while the total isn't known.
export function percent(download: Pick<Download, "bytes" | "total">): number | undefined {
  if (download.total <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((download.bytes / download.total) * 100)));
}

// The waiting reasons (downloads.WaitWiFi and its neighbours).
const waits: ReadonlySet<string> = new Set(["wifi", "offline", "suspended"]);

// "Queued", "Downloading 42 %", "Waiting for Wi-Fi", "Downloaded": a row's
// line in the Downloads view and on a title.
export function statusText(
  download: Pick<Download, "state" | "bytes" | "total" | "reason">,
): string {
  switch (statusOf(download)) {
    case "downloading": {
      const done = percent(download);
      return done === undefined ? "Downloading" : `Downloading ${done} %`;
    }
    case "paused":
      return "Paused";
    case "waiting":
      return waits.has(download.reason) ? reasonText(download.reason) : "Waiting";
    case "failed":
      return download.reason ? `Failed: ${reasonText(download.reason)}` : "Failed";
    case "done":
      return "Downloaded";
    default:
      return "Queued";
  }
}

// What each reason and code says, in the words the screens and toasts use.
// The wait reasons read as what the row is doing; the codes as what went
// wrong, in lib/resolve's voice.
const reasons: Readonly<Record<string, string>> = {
  // Waiting.
  wifi: "Waiting for Wi-Fi",
  offline: "Waiting for a connection",
  suspended: "Waiting to resume",
  // The device refused it (internal/downloads' codes).
  over_cap: "Over the downloads limit",
  no_space: "Not enough space",
  kids_profile: "Kids profiles can’t do that",
  not_allowed: "Kids profiles can’t download this",
  unsupported: "Peli can’t do that here",
  invalid: "That download is missing something",
  not_found: "That download is gone",
  // The stream failed.
  expired: "The link expired. Download it again.",
  size_mismatch: "The download didn’t finish. Try it again.",
  caching: "Your debrid service is still caching it",
  denied: "Your debrid service refused the stream",
  busy: "Your debrid service is busy. Try again in a little while",
  failed: "That stream wouldn’t download. Try another one",
  not_video: "That link isn’t a video",
  unreachable: "Couldn’t reach the stream. Check your connection",
  timeout: "The stream didn’t answer. Try again",
};

// A waiting job's reason, or a refusal's code, as a line for the user.
export function reasonText(reason: string | undefined): string {
  return (reason ? reasons[reason] : undefined) ?? "Something went wrong";
}

// A refused call's message: downloads.MarshalError's code, in the same words.
export const downloadErrorText = (code: string | undefined) => reasonText(code);

// "Breaking Bad · S1 E3", or the film's name.
export const downloadLabel = (download: Pick<Download, "name" | "season" | "episode">) =>
  download.season > 0
    ? `${download.name} · S${download.season} E${download.episode}`
    : download.name;

// --- What to download ---------------------------------------------------------

// Whether a stream can be downloaded at all: Go fetches a link, so a torrent
// (no url, or a magnet) never is, and its Download action is hidden
// (ADR-0064, the user's call).
export function downloadable(stream: Stream): boolean {
  const url = stream.url ?? "";
  return url !== "" && !url.startsWith("magnet:");
}

// What addRequestFor is given: the picker's pick and what the title page
// knows of it.
export type AddRequestParts = {
  profileId: number;
  meta: Meta;
  // The episode, or a film's video; none for a film that plays its own id.
  video?: Video | undefined;
  // The addon whose details served meta (a kids profile may download only
  // what its own addons served).
  metaAddon: string;
  candidate: Candidate;
  // Addon subtitles in the profile's language, from subtitleRefs.
  subtitles?: readonly SubtitleRef[] | undefined;
};

// The AddRequest for a ranked stream, from what the picker and the title
// page have: lib/title's watchingFor names the film or episode exactly as
// progress and watched items are named, and the request is the stream's own
// link with the headers its addon asks for, as resolvePick sends them.
export function addRequestFor({
  profileId,
  meta,
  video,
  metaAddon,
  candidate,
  subtitles,
}: AddRequestParts): AddRequest {
  const target: PlayTarget = {
    type: meta.type,
    id: meta.id,
    title: meta.name,
    videoId: video?.id ?? meta.behaviorHints?.defaultVideoId ?? meta.id,
  };
  const watching = watchingFor(profileId, target, meta, []);
  const stream = candidate.stream;
  const season = watching.season ?? 0;
  return {
    profileId,
    contentId: watching.contentId,
    contentType: watching.contentType,
    videoId: watching.videoId,
    season,
    episode: watching.episode ?? 0,
    name: watching.name || meta.name,
    // The show's name is no episode's: only an episode has one.
    episodeName: season > 0 ? (video?.title ?? "") : "",
    poster: meta.poster ?? "",
    metaAddon,
    streamSource: candidate.source,
    streamName: (stream.name ?? "").trim(),
    streamDescription: stream.description ?? stream.title ?? "",
    resolution: candidate.parsed.resolution ?? "",
    request: {
      url: stream.url ?? "",
      headers: stream.behaviorHints?.proxyHeaders?.request ?? {},
    },
    subtitles: subtitles?.length ? [...subtitles] : null,
  };
}

// Go saves ten of them (downloads.Add).
const maxSubtitles = 10;

// The addon subtitles to save beside the file: those in the profile's
// language, in the addons' order (the best match first), as Go takes them.
// The addon subtitles themselves come from useAddonSubtitles, a hook, so
// they are gathered where a component can call it: the report says how.
export function subtitleRefs(
  subtitles: readonly AddonSubtitle[],
  preferred: string,
): SubtitleRef[] {
  const want = subtitleLanguage(preferred).code;
  if (!want) return [];
  return subtitles
    .filter((subtitle) => subtitle.code === want && /^https?:/i.test(subtitle.url))
    .slice(0, maxSubtitles)
    .map((subtitle) => ({ url: subtitle.url, lang: want, title: subtitle.name }));
}
