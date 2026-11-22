import { describe, expect, it, vi } from "vite-plus/test";

import type { Download } from "@bindings/store";
import type { Meta, Stream } from "@/lib/addon-protocol";
import { rankStreams, type Candidate, type TitleContext } from "@/lib/ranking";
import { defaultPrefs } from "@/lib/ranking/score";

import {
  downloadControl,
  downloadOf,
  downloadRows,
  downloadState,
  downloadVideoId,
  findingText,
  pendingOf,
  pressDownload,
  topDownloadable,
  videoToDownload,
  type DownloadQueue,
  type TitleDownloads,
} from "./download-pick";

vi.mock("@/components/ui/toast", () => ({ toastManager: { add: vi.fn<() => void>() } }));

// Picking what to download (#85, ADR-0064): the best ranked stream that has a
// link, never a torrent, and what a Download control says about it.

const movie: Meta = {
  id: "tt0111161",
  type: "movie",
  name: "The Shawshank Redemption",
  poster: "https://images.metahub.space/poster/small/tt0111161/img",
  behaviorHints: { defaultVideoId: "tt0111161" },
};

const episodes = [
  { id: "tt0903747:1:1", title: "Pilot", season: 1, episode: 1 },
  { id: "tt0903747:1:2", title: "Cat's in the Bag...", season: 1, episode: 2 },
];
const series: Meta = { id: "tt0903747", type: "series", name: "Breaking Bad", videos: episodes };

const torrentio = "https://torrentio.example/manifest.json";
const peerflix = "https://peerflix.example/manifest.json";

// A Torrentio-style debrid stream: a link Go can fetch.
const debrid = (file: string): Stream => ({
  name: "[TB+] Torrentio\n1080p",
  title: `${file}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.example/resolve/torbox/KEY/0000000000000000000000000000000000000000/null/0/${file}`,
});

// A torrent with no link: Peli can't download it (ADR-0064).
const torrent = (file: string): Stream => ({
  name: "Peerflix\n1080p",
  description: `${file}\n👤 59 💾 2.1 GB`,
  infoHash: "9cf3225d39f3a46c34cc149101dd8560c574a21b",
  fileIdx: 2,
  sources: ["tracker:udp://open.stealth.si:80/announce"],
});

const linked = debrid("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
const magnet = torrent("Some.Show.S01E02.1080p.WEB-DL.x264-GRP.mkv");

const context: TitleContext = {
  type: "series",
  anime: false,
  id: "tt0903747:1:2",
  name: "Breaking Bad",
  year: 2008,
  runtimeMin: 49,
  season: 1,
  episode: 2,
};

// One answer ranked, with `remembered` (the show's last played source) on top.
const ranked = (answers: { source: string; streams: Stream[] }[], remembered?: string) =>
  rankStreams(context, answers, {
    ...defaultPrefs,
    remembered: remembered ? { source: remembered, resolution: "1080p", group: null } : null,
  });

describe("the stream to download", () => {
  it("takes the top pick when it has a link", () => {
    const view = ranked([{ source: torrentio, streams: [linked] }]);
    expect(topDownloadable(view)?.stream.url).toBe(linked.url);
  });

  it("skips a torrent-only top pick for the best one with a link", () => {
    const view = ranked(
      [
        { source: peerflix, streams: [magnet] },
        { source: torrentio, streams: [linked] },
      ],
      peerflix,
    );
    // The remembered source puts the torrent on top; it can't be downloaded.
    expect(view.top?.stream.infoHash).toBeTruthy();
    expect(view.top?.stream.url).toBeUndefined();
    expect(topDownloadable(view)?.stream.url).toBe(linked.url);
  });

  it("finds nothing when every stream is a torrent", () => {
    const view = ranked([{ source: peerflix, streams: [magnet] }], peerflix);
    expect(topDownloadable(view)).toBeUndefined();
  });
});

describe("which video a control is for", () => {
  it("is the film itself, or its default video", () => {
    expect(downloadVideoId(movie)).toBe("tt0111161");
    expect(downloadVideoId(movie, undefined)).toBe("tt0111161");
    const withVideo: Meta = { ...movie, behaviorHints: { defaultVideoId: "tt0111161:special" } };
    expect(downloadVideoId(withVideo)).toBe("tt0111161:special");
  });

  it("is the episode's id", () => {
    expect(downloadVideoId(series, episodes[1])).toBe("tt0903747:1:2");
  });

  it("takes a film as its own video, and a series' next-up episode", () => {
    expect(videoToDownload(movie, "tt0111161", false)).toEqual({
      video: undefined,
      canDownload: true,
    });
    expect(videoToDownload(series, "tt0903747:1:2", true)).toEqual({
      video: episodes[1],
      canDownload: true,
    });
    // Nothing to play: nothing to download.
    expect(videoToDownload(series, undefined, true)).toEqual({
      video: undefined,
      canDownload: false,
    });
  });
});

const record = (over: Partial<Download> = {}): Download => ({
  id: "0123456789abcdef0123456789abcdef",
  profileId: 1,
  contentId: "tt0903747",
  contentType: "series",
  videoId: "tt0903747:1:2",
  season: 1,
  episode: 2,
  name: "Breaking Bad",
  episodeName: "Cat's in the Bag...",
  poster: "",
  metaAddon: "https://v3-cinemeta.strem.io/manifest.json",
  streamSource: torrentio,
  streamName: "Torrentio",
  streamDescription: "",
  resolution: "1080p",
  request: { url: linked.url ?? "", headers: null },
  root: "",
  file: "video.mkv",
  mimeType: "video/x-matroska",
  subtitles: null,
  segments: null,
  state: "done",
  reason: "",
  bytes: 100,
  total: 100,
  createdAt: 1,
  updatedAt: 2,
  doneAt: 3,
  ...over,
});

// A queue that only records: `finding` is `true` for the videos given.
function queueOf(
  over: Partial<DownloadQueue> = {},
  finding: (videoId: string | undefined) => boolean = () => false,
): DownloadQueue {
  return {
    download: vi.fn<(target: unknown) => void>(),
    downloadMany: vi.fn<(targets: readonly unknown[]) => void>(),
    stop: vi.fn<() => void>(),
    running: false,
    finding,
    runner: null,
    ...over,
  };
}

const actionsOf = () => ({
  add: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  pause: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  resume: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  remove: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  removeAll: vi.fn<() => Promise<void>>(() => Promise.resolve()),
});

const downloadsOf = (
  list: readonly Download[] = [],
  queue: DownloadQueue = queueOf(),
): TitleDownloads => ({ profileId: 1, list, queue, actions: actionsOf() });

describe("what a Download control says", () => {
  it("offers the download when the video has none", () => {
    expect(downloadControl(undefined, false)).toEqual({ label: "Download", action: "download" });
  });

  it("says a stream is being found", () => {
    expect(downloadControl(undefined, true)).toEqual({ label: findingText, action: "none" });
    expect(findingText).toBe("Finding a stream…");
  });

  it("shows the record's own status, and what pressing it does", () => {
    expect(downloadControl(record({ state: "queued" }), false)).toEqual({
      label: "Queued",
      action: "none",
    });
    expect(downloadControl(record({ state: "downloading", bytes: 42, total: 100 }), false)).toEqual(
      { label: "Downloading 42 %", action: "none" },
    );
    expect(downloadControl(record({ state: "paused" }), false)).toEqual({
      label: "Paused",
      action: "resume",
    });
    expect(downloadControl(record({ state: "failed", reason: "expired" }), false)).toEqual({
      label: "Failed: The link expired. Download it again.",
      action: "resume",
    });
    expect(downloadControl(record({ state: "done" }), false)).toEqual({
      label: "Downloaded",
      action: "remove",
    });
    // A record wins over a ranking in flight.
    expect(downloadControl(record({ state: "done" }), true).label).toBe("Downloaded");
  });
});

describe("what a menu shows", () => {
  it("offers the download by the caller's name", () => {
    const state = downloadState(downloadsOf(), series, "cinemeta", episodes[1]);
    expect(downloadRows(state, "Download next episode")).toEqual({
      start: { label: "Download next episode", disabled: false },
    });
  });

  it("holds the row while a stream is found", () => {
    const queue = queueOf({}, (videoId) => videoId !== undefined);
    const state = downloadState(downloadsOf([], queue), series, "cinemeta", episodes[0]);
    expect(downloadRows(state, "Download")).toEqual({
      start: { label: findingText, disabled: true },
    });
  });

  it("shows the status, a resume and a removal for a record", () => {
    const paused = downloadState(
      downloadsOf([record({ state: "paused" })]),
      series,
      "cinemeta",
      episodes[1],
    );
    expect(downloadRows(paused, "Download")).toEqual({
      status: "Paused",
      resume: true,
      remove: true,
    });
    const done = downloadState(
      downloadsOf([record({ state: "done" })]),
      series,
      "cinemeta",
      episodes[1],
    );
    expect(downloadRows(done, "Download")).toEqual({
      status: "Downloaded",
      resume: false,
      remove: true,
    });
  });
});

describe("pressing a control", () => {
  it("queues the film or episode it is for", () => {
    const queue = queueOf();
    const downloads = downloadsOf([], queue);
    pressDownload(downloadState(downloads, series, "cinemeta", episodes[1]), downloads);
    expect(queue.download).toHaveBeenCalledWith({
      meta: series,
      video: episodes[1],
      metaAddon: "cinemeta",
    });
  });

  it("resumes a paused download", () => {
    const paused = record({ state: "paused" });
    const actions = actionsOf();
    const downloads = { ...downloadsOf([paused]), actions };
    pressDownload(downloadState(downloads, series, "cinemeta", episodes[1]), downloads);
    expect(actions.resume).toHaveBeenCalledWith(paused.id);
  });

  it("asks before removing a finished one, and removes a partial at once", () => {
    const done = record({ state: "done" });
    const actions = actionsOf();
    const finished = { ...downloadsOf([done]), actions };
    const ask = vi.fn<(download: Download) => void>();
    pressDownload(downloadState(finished, series, "cinemeta", episodes[1]), finished, ask);
    expect(ask).toHaveBeenCalledWith(done);
    expect(actions.remove).not.toHaveBeenCalled();

    const partial = record({ state: "downloading", bytes: 10, total: 100 });
    const downloading = { ...downloadsOf([partial]), actions };
    pressDownload(downloadState(downloading, series, "cinemeta", episodes[1]), downloading);
    expect(actions.remove).toHaveBeenCalledWith([partial.id]);
  });
});

describe("the record of one stream", () => {
  // The top ranked stream of one answer, as the picker's rows have it.
  const candidateOf = (streams: Stream[]) => ranked([{ source: torrentio, streams }]).top!;

  it("is the record with the same video and link, whatever its state", () => {
    const candidate = candidateOf([linked]);
    const queued = record({ state: "queued", doneAt: 0 });
    // Queued is not downloaded: the record is still the row's own.
    expect(downloadOf([queued], "tt0903747:1:2", candidate)).toBe(queued);
  });

  it("is not another link's record", () => {
    const candidate = candidateOf([linked]);
    const other = record({
      request: { url: "https://torrentio.example/resolve/torbox/KEY/other.mkv", headers: null },
    });
    expect(downloadOf([other], "tt0903747:1:2", candidate)).toBeUndefined();
  });

  it("is not another video's record", () => {
    const candidate = candidateOf([linked]);
    expect(downloadOf([record()], "tt0903747:1:3", candidate)).toBeUndefined();
    // A row with no video of its own (outside the picker) matches nothing.
    expect(downloadOf([record()], undefined, candidate)).toBeUndefined();
  });

  it("is the newest of two records for the same stream", () => {
    const candidate = candidateOf([linked]);
    const older = record({ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state: "failed" });
    const newer = record({
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      state: "downloading",
      bytes: 40,
      total: 100,
    });
    expect(downloadOf([older, newer], "tt0903747:1:2", candidate)).toBe(newer);
  });
});

describe("a stream whose Add is out", () => {
  const one = ranked([{ source: torrentio, streams: [linked] }]).top!;
  // Another row of the same answer: the same shape, its own key.
  const two: Candidate = { ...one, key: `${one.key}#2` };

  it("is pending only for its own candidate", () => {
    expect(two.key).not.toBe(one.key);
    expect(pendingOf(one, one)).toBe(true);
    expect(pendingOf(one, two)).toBe(false);
    expect(pendingOf(null, one)).toBe(false);
  });
});
