import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Service as Downloads, type AddRequest } from "@bindings/downloads";
import type { Download } from "@bindings/store";
import type * as Runtime from "@wailsio/runtime";

import { toastManager } from "@/components/ui/toast";
import type { Meta, Stream, Video } from "@/lib/addon-protocol";
import {
  addRequestFor,
  changedEvent,
  downloadErrorText,
  downloadFor,
  downloadLabel,
  downloadable,
  downloadsKey,
  downloadUsageQuery,
  percent,
  playableKey,
  progressEvent,
  reasonText,
  removedEvent,
  statusOf,
  statusText,
  subtitleRefs,
  useDownloadActions,
  useDownloadEvents,
  useDownloadRate,
} from "@/lib/downloads";
import { candidate, titleContext } from "@/lib/ranking";

// Downloads (#85, ADR-0064): the words the screens use, the AddRequest the
// picker builds, and the events patching the queries Go's records live in.

// Wails' events, by hand: a Set of listeners per event, so a test sends one
// and sees the hook's unsubscribe.
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { data: unknown }) => void>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        const callbacks: Set<(event: { data: unknown }) => void> =
          mocks.listeners.get(name) ?? new Set();
        callbacks.add(callback);
        mocks.listeners.set(name, callbacks);
        return () => void callbacks.delete(callback);
      },
    },
  };
});

beforeEach(() => {
  mocks.listeners.clear();
});

function emit(name: string, data: unknown) {
  act(() => {
    for (const callback of mocks.listeners.get(name) ?? []) callback({ data });
  });
}

// A record as the store keeps it.
function download(changes: Partial<Download> = {}): Download {
  return {
    id: "a1",
    profileId: 1,
    contentId: "tt0903747",
    contentType: "series",
    videoId: "tt0903747:1:2",
    season: 1,
    episode: 2,
    name: "Breaking Bad",
    episodeName: "Cat’s in the Bag…",
    poster: "https://p.jpg",
    metaAddon: "https://addon.example/manifest.json",
    streamSource: "https://addon.example/manifest.json",
    streamName: "TorBox 1080p",
    streamDescription: "Breaking.Bad.S01E02.1080p.mkv",
    resolution: "1080p",
    request: { url: "https://cdn.example/file.mkv", headers: { "User-Agent": "Stremio" } },
    root: "",
    file: "a1/video.mkv",
    mimeType: "video/x-matroska",
    subtitles: null,
    segments: null,
    state: "queued",
    reason: "",
    bytes: 0,
    total: 0,
    createdAt: 1,
    updatedAt: 1,
    doneAt: 0,
    ...changes,
  };
}

// No JSX here: this file is a .ts, as the part asked.
function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("statusOf", () => {
  it("names Go's six states", () => {
    for (const state of ["queued", "downloading", "paused", "waiting", "failed", "done"]) {
      expect(statusOf({ state })).toBe(state);
    }
  });

  it("takes anything else as queued", () => {
    expect(statusOf({ state: "" })).toBe("queued");
    expect(statusOf({ state: "cancelled" })).toBe("queued");
  });
});

describe("percent", () => {
  it("is how far along, 0 to 100", () => {
    expect(percent({ bytes: 0, total: 200 })).toBe(0);
    expect(percent({ bytes: 50, total: 200 })).toBe(25);
    expect(percent({ bytes: 200, total: 200 })).toBe(100);
    expect(percent({ bytes: 63, total: 200 })).toBe(32);
  });

  it("is undefined while the size isn't known, and never passes 100", () => {
    expect(percent({ bytes: 500, total: 0 })).toBeUndefined();
    expect(percent({ bytes: 0, total: 0 })).toBeUndefined();
    expect(percent({ bytes: 300, total: 200 })).toBe(100);
    expect(percent({ bytes: -5, total: 200 })).toBe(0);
  });
});

describe("statusText", () => {
  it("says what the row is doing", () => {
    expect(statusText(download({ state: "queued" }))).toBe("Queued");
    expect(statusText(download({ state: "downloading", bytes: 42, total: 100 }))).toBe(
      "Downloading 42 %",
    );
    expect(statusText(download({ state: "downloading", bytes: 5, total: 0 }))).toBe("Downloading");
    expect(statusText(download({ state: "paused", bytes: 42, total: 100 }))).toBe("Paused");
    expect(statusText(download({ state: "done", bytes: 100, total: 100 }))).toBe("Downloaded");
  });

  it("says why a job waits", () => {
    expect(statusText(download({ state: "waiting", reason: "wifi" }))).toBe("Waiting for Wi-Fi");
    expect(statusText(download({ state: "waiting", reason: "offline" }))).toBe(
      "Waiting for a connection",
    );
    expect(statusText(download({ state: "waiting", reason: "suspended" }))).toBe(
      "Waiting to resume",
    );
    expect(statusText(download({ state: "waiting", reason: "" }))).toBe("Waiting");
  });

  it("says what went wrong", () => {
    expect(statusText(download({ state: "failed", reason: "no_space" }))).toBe(
      "Failed: Not enough space",
    );
    expect(statusText(download({ state: "failed", reason: "expired" }))).toBe(
      "Failed: The link expired. Download it again.",
    );
    expect(statusText(download({ state: "failed", reason: "" }))).toBe("Failed");
  });
});

describe("reasonText", () => {
  it("says each wait reason", () => {
    expect(reasonText("wifi")).toBe("Waiting for Wi-Fi");
    expect(reasonText("offline")).toBe("Waiting for a connection");
    expect(reasonText("suspended")).toBe("Waiting to resume");
  });

  it("says each of Go's codes", () => {
    expect(reasonText("over_cap")).toBe("Over the downloads limit");
    expect(reasonText("no_space")).toBe("Not enough space");
    expect(reasonText("expired")).toBe("The link expired. Download it again.");
    expect(reasonText("caching")).toBe("Your debrid service is still caching it");
    expect(reasonText("size_mismatch")).toContain("didn’t finish");
    expect(reasonText("denied")).toContain("refused");
    expect(reasonText("busy")).toContain("busy");
    expect(reasonText("failed")).toContain("Try another");
    expect(reasonText("not_video")).toBe("That link isn’t a video");
    expect(reasonText("unreachable")).toContain("Check your connection");
    expect(reasonText("timeout")).toContain("didn’t answer");
    expect(reasonText("not_allowed")).toContain("Kids profiles");
    expect(reasonText("kids_profile")).toContain("Kids profiles");
    expect(reasonText("unsupported")).toContain("Peli can’t");
    // Nothing to name it by, and nothing Peli knows.
    expect(reasonText(undefined)).toBe("Something went wrong");
    expect(reasonText("")).toBe("Something went wrong");
    expect(reasonText("meteor")).toBe("Something went wrong");
  });

  it("is what a refused call says", () => {
    expect(downloadErrorText("over_cap")).toBe("Over the downloads limit");
    expect(downloadErrorText(undefined)).toBe("Something went wrong");
    expect(downloadErrorText("no_space")).toBe(reasonText("no_space"));
  });
});

describe("downloadLabel", () => {
  it("names an episode with its code, a film by its name", () => {
    expect(downloadLabel(download())).toBe("Breaking Bad · S1 E2");
    expect(downloadLabel(download({ season: 0, episode: 0, name: "The Matrix" }))).toBe(
      "The Matrix",
    );
  });
});

describe("downloadFor", () => {
  it("finds the record for a video, and nothing for another", () => {
    const list = [download({ id: "a1" }), download({ id: "b2", videoId: "tt0903747:1:3" })];
    expect(downloadFor(list, "tt0903747:1:2")?.id).toBe("a1");
    expect(downloadFor(list, "tt0903747:1:9")).toBeUndefined();
    expect(downloadFor(list, undefined)).toBeUndefined();
  });

  it("takes the newest of two for the same video", () => {
    const list = [download({ id: "old" }), download({ id: "new" })];
    expect(downloadFor(list, "tt0903747:1:2")?.id).toBe("new");
  });
});

describe("downloadable", () => {
  it("is every stream with a link", () => {
    expect(downloadable({ url: "https://cdn.example/file.mkv" })).toBe(true);
    expect(downloadable({ url: "http://addon.example/download/42" })).toBe(true);
  });

  it("is no torrent: Go downloads a link, never a magnet", () => {
    expect(downloadable({ infoHash: "abc123", fileIdx: 0 })).toBe(false);
    expect(downloadable({ url: "", infoHash: "abc123" })).toBe(false);
    expect(downloadable({ url: "magnet:?xt=urn:btih:abc123" })).toBe(false);
    expect(downloadable({ ytId: "dQw4w9WgXcQ" })).toBe(false);
  });
});

describe("subtitleRefs", () => {
  it("keeps the profile's language, in the addons' order", () => {
    const subtitles = [
      addon("https://subs/1.srt", "en", "One"),
      addon("https://subs/2.srt", "pt"),
      addon("https://subs/3.vtt", "en", "Three"),
    ];
    expect(subtitleRefs(subtitles, "en")).toEqual([
      { url: "https://subs/1.srt", lang: "en", title: "One" },
      { url: "https://subs/3.vtt", lang: "en", title: "Three" },
    ]);
  });

  it("takes a regional profile language by its ISO code", () => {
    expect(subtitleRefs([addon("https://subs/1.srt", "pt", "Um")], "pt-BR")).toEqual([
      { url: "https://subs/1.srt", lang: "pt", title: "Um" },
    ]);
  });

  it("keeps the ten Go saves, and nothing without a language", () => {
    const many = Array.from({ length: 12 }, (_, index) => addon(`https://subs/${index}.srt`, "en"));
    expect(subtitleRefs(many, "en")).toHaveLength(10);
    expect(subtitleRefs([addon("https://subs/1.srt", "en")], "")).toEqual([]);
    // Go saves http links only.
    expect(subtitleRefs([addon("/local/1.srt", "en")], "en")).toEqual([]);
  });
});

describe("addRequestFor", () => {
  const source = "https://addon.example/manifest.json";
  const stream: Stream = {
    name: "TorBox 1080p",
    description: "The.Matrix.1999.1080p.WEB-DL.mkv",
    url: "https://cdn.example/file.mkv",
    behaviorHints: {
      filename: "The.Matrix.1999.1080p.WEB-DL.mkv",
      proxyHeaders: { request: { "User-Agent": "Stremio", Authorization: "Bearer x" } },
    },
  };

  it("asks for a film by its own video id", () => {
    const meta: Meta = {
      id: "tt0133093",
      type: "movie",
      name: "The Matrix",
      poster: "https://p.jpg",
    };
    const pick = candidate(source, stream, 0, titleContext("movie", meta.id, meta, meta.name));
    const request = addRequestFor({
      profileId: 2,
      meta,
      metaAddon: source,
      candidate: pick,
      subtitles: [{ url: "https://subs/en.srt", lang: "en", title: "English" }],
    });
    expect(request).toEqual({
      profileId: 2,
      contentId: "tt0133093",
      contentType: "movie",
      videoId: "tt0133093",
      season: 0,
      episode: 0,
      name: "The Matrix",
      episodeName: "",
      poster: "https://p.jpg",
      metaAddon: source,
      streamSource: source,
      streamName: "TorBox 1080p",
      streamDescription: "The.Matrix.1999.1080p.WEB-DL.mkv",
      resolution: "1080p",
      request: {
        url: "https://cdn.example/file.mkv",
        headers: { "User-Agent": "Stremio", Authorization: "Bearer x" },
      },
      subtitles: [{ url: "https://subs/en.srt", lang: "en", title: "English" }],
    });
  });

  it("asks for an episode with its season, number and name", () => {
    const episode: Video = {
      id: "tt0903747:1:2",
      title: "Cat’s in the Bag…",
      season: 1,
      episode: 2,
    };
    const meta: Meta = {
      id: "tt0903747",
      type: "series",
      name: "Breaking Bad",
      videos: [episode],
    };
    const episodeStream: Stream = {
      name: "TorBox 2160p",
      description: "Breaking.Bad.S01E02.2160p.mkv",
      url: "https://cdn.example/file.mkv",
      behaviorHints: { filename: "Breaking.Bad.S01E02.2160p.mkv" },
    };
    const pick = candidate(
      source,
      episodeStream,
      0,
      titleContext("series", episode.id, meta, meta.name),
    );
    const request = addRequestFor({
      profileId: 3,
      meta,
      video: episode,
      metaAddon: source,
      candidate: pick,
    });
    expect(request).toMatchObject({
      profileId: 3,
      contentId: "tt0903747",
      contentType: "series",
      videoId: "tt0903747:1:2",
      season: 1,
      episode: 2,
      name: "Breaking Bad",
      episodeName: "Cat’s in the Bag…",
      poster: "",
      resolution: "2160p",
      streamName: "TorBox 2160p",
      // No subtitles given: Go saves none.
      subtitles: null,
    });
    expect(request.request).toEqual({ url: "https://cdn.example/file.mkv", headers: {} });
  });

  it("passes on a stream's own headers only, and none when it has none", () => {
    const meta: Meta = { id: "tt0133093", type: "movie", name: "The Matrix" };
    const bare: Stream = { url: "https://cdn.example/file.mkv" };
    const pick = candidate(source, bare, 0, titleContext("movie", meta.id, meta, meta.name));
    const request = addRequestFor({ profileId: 2, meta, metaAddon: source, candidate: pick });
    expect(request.request.headers).toEqual({});
    expect(request.subtitles).toBeNull();
    expect(request.streamName).toBe("");
  });
});

describe("useDownloadEvents", () => {
  it("upserts a changed record into its profile's list, and freshens the rest", () => {
    const client = new QueryClient();
    const mine = download({ id: "a1", name: "Breaking Bad" });
    const other = download({ id: "b2", profileId: 2, videoId: "tt1:1:1" });
    client.setQueryData(downloadsKey(1), [mine]);
    client.setQueryData(downloadsKey(2), [other]);
    client.setQueryData(downloadUsageQuery.queryKey, { used: 0, cap: 0, free: 0, dir: "" });
    client.setQueryData(playableKey(1, mine.videoId), null);

    renderHook(() => useDownloadEvents(), { wrapper: wrapper(client) });

    const changed = download({
      id: "a1",
      name: "Breaking Bad",
      state: "downloading",
      bytes: 10,
      total: 100,
    });
    emit(changedEvent, changed);

    expect(client.getQueryData(downloadsKey(1))).toEqual([changed]);
    // Another profile's list is not ours to change.
    expect(client.getQueryData(downloadsKey(2))).toEqual([other]);
    expect(client.getQueryState(downloadUsageQuery.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(playableKey(1, mine.videoId))?.isInvalidated).toBe(true);
  });

  it("adds a record the list doesn't have yet", () => {
    const client = new QueryClient();
    client.setQueryData(downloadsKey(1), []);
    renderHook(() => useDownloadEvents(), { wrapper: wrapper(client) });

    emit(changedEvent, download({ id: "new" }));

    expect(client.getQueryData<Download[]>(downloadsKey(1))).toHaveLength(1);
    expect(client.getQueryData<Download[]>(downloadsKey(1))?.[0]?.id).toBe("new");
  });

  it("patches a running job's bytes and keeps its speed for the row", () => {
    const client = new QueryClient();
    client.setQueryData(downloadsKey(1), [
      download({ id: "a1" }),
      download({ id: "a2", videoId: "tt2" }),
    ]);
    const { result } = renderHook(
      () => ({ events: useDownloadEvents(), rate: useDownloadRate("a1") }),
      { wrapper: wrapper(client) },
    );
    expect(result.current.rate).toBe(0);

    emit(progressEvent, { id: "a1", bytes: 50, total: 200, rate: 1_500_000 });

    const list = client.getQueryData<Download[]>(downloadsKey(1));
    expect(list?.[0]).toMatchObject({ id: "a1", bytes: 50, total: 200 });
    // The other download is left as it was.
    expect(list?.[1]).toMatchObject({ id: "a2", bytes: 0, total: 0 });
    expect(result.current.rate).toBe(1_500_000);
  });

  it("keeps a known size when the server doesn't send one", () => {
    const client = new QueryClient();
    client.setQueryData(downloadsKey(1), [download({ id: "a1", total: 900 })]);
    renderHook(() => useDownloadEvents(), { wrapper: wrapper(client) });

    emit(progressEvent, { id: "a1", bytes: 40, total: 0, rate: 800 });

    expect(client.getQueryData<Download[]>(downloadsKey(1))?.[0]).toMatchObject({
      bytes: 40,
      total: 900,
    });
  });

  it("drops what was deleted, and its speed", () => {
    const client = new QueryClient();
    client.setQueryData(downloadsKey(1), [
      download({ id: "a1" }),
      download({ id: "a2", videoId: "tt2" }),
    ]);
    client.setQueryData(downloadUsageQuery.queryKey, { used: 0, cap: 0, free: 0, dir: "" });
    client.setQueryData(playableKey(1, "tt2"), null);
    const { result } = renderHook(
      () => ({ events: useDownloadEvents(), rate: useDownloadRate("a1") }),
      { wrapper: wrapper(client) },
    );
    emit(progressEvent, { id: "a1", bytes: 10, total: 100, rate: 900 });
    expect(result.current.rate).toBe(900);

    emit(removedEvent, { ids: ["a1"] });

    expect(client.getQueryData<Download[]>(downloadsKey(1))).toEqual([
      expect.objectContaining({ id: "a2" }),
    ]);
    expect(result.current.rate).toBe(0);
    expect(client.getQueryState(playableKey(1, "tt2"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(downloadUsageQuery.queryKey)?.isInvalidated).toBe(true);
  });

  it("says nothing of a removal with no ids, and unsubscribes when unmounted", () => {
    const client = new QueryClient();
    client.setQueryData(downloadsKey(1), [download({ id: "a1" })]);
    const { unmount } = renderHook(() => useDownloadEvents(), { wrapper: wrapper(client) });

    emit(removedEvent, { ids: null });
    expect(client.getQueryData<Download[]>(downloadsKey(1))).toHaveLength(1);

    unmount();
    expect(mocks.listeners.get(changedEvent)?.size ?? 0).toBe(0);
    expect(mocks.listeners.get(progressEvent)?.size ?? 0).toBe(0);
    expect(mocks.listeners.get(removedEvent)?.size ?? 0).toBe(0);
  });
});

describe("useDownloadActions", () => {
  it("says a refusal in Go's words, and resolves either way", async () => {
    const client = new QueryClient();
    const add = vi.spyOn(toastManager, "add");
    vi.mocked(Downloads.Pause).mockRejectedValue(refusal("busy"));
    const { result } = renderHook(() => useDownloadActions(4), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.pause("a1");
    });

    expect(Downloads.Pause).toHaveBeenCalledWith(4, "a1");
    expect(add).toHaveBeenCalledWith({
      type: "error",
      title: "Your debrid service is busy. Try again in a little while",
    });
  });

  it("names what it added, and deletes the ids the row gives", async () => {
    const client = new QueryClient();
    const add = vi.spyOn(toastManager, "add");
    const { result } = renderHook(() => useDownloadActions(4), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.add(addRequest());
      await result.current.remove(["a1", "a2"]);
    });

    expect(Downloads.Add).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 1, videoId: "tt0903747:1:2" }),
    );
    expect(add).toHaveBeenCalledWith({
      type: "success",
      title: "Download started",
      description: "Breaking Bad · S1 E2",
      // The tray opens from the toast's one action.
      actionProps: expect.objectContaining({ children: "Show" }),
    });
    expect(Downloads.Delete).toHaveBeenCalledWith(4, ["a1", "a2"]);
  });

  it("does nothing without a profile", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useDownloadActions(undefined), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.pause("a1");
      await result.current.removeAll();
    });

    expect(Downloads.Pause).not.toHaveBeenCalled();
    expect(Downloads.DeleteAll).not.toHaveBeenCalled();
  });
});

function addon(url: string, code: string, name = "") {
  return {
    key: `addon ${url}`,
    url,
    language: code,
    code,
    name,
    addon: "OpenSubtitles v3",
  };
}

// A refusal as downloads.MarshalError sends it: the code in the call's cause.
function refusal(code: string): Error {
  const error = new Error(`downloads: ${code}`);
  Object.defineProperty(error, "cause", { value: { code } });
  return error;
}

function addRequest(changes: Partial<AddRequest> = {}): AddRequest {
  return {
    profileId: 1,
    contentId: "tt0903747",
    contentType: "series",
    videoId: "tt0903747:1:2",
    season: 1,
    episode: 2,
    name: "Breaking Bad",
    episodeName: "Cat’s in the Bag…",
    poster: "",
    metaAddon: "https://addon.example/manifest.json",
    streamSource: "https://addon.example/manifest.json",
    streamName: "TorBox 1080p",
    streamDescription: "",
    resolution: "1080p",
    request: { url: "https://cdn.example/file.mkv", headers: {} },
    subtitles: null,
    ...changes,
  };
}
