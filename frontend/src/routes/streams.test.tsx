import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Plugin, Query, Stream as PluginStream } from "@bindings/plugins";
import type { Addon, ChosenSource, DeviceSettings, Profile, Progress } from "@bindings/store";
import type { Request, Source } from "@bindings/streams";
import type { Request as TorrentRequest, Status } from "@bindings/torrent";
import { defaultQuality } from "@/lib/quality";
import { defaultAudio } from "@/lib/sound";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import peerflixManifest from "@/lib/addon-protocol/fixtures/peerflix/manifest.json";
import peerflixMovie from "@/lib/addon-protocol/fixtures/peerflix/stream-movie.json";
import torrentioManifest from "@/lib/addon-protocol/fixtures/torrentio/manifest.json";
import torrentioSeries from "@/lib/addon-protocol/fixtures/torrentio/stream-series.json";
import { Party } from "@/lib/party";
import { deviceSettingsQuery } from "@/lib/settings";
import { keepForSession, noFilters } from "@/lib/stream-filters";
import { sizeLabel } from "@/lib/stream-labels";
import { partyState } from "@/test/fixtures";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  resolve: vi.fn<(request: Request) => Promise<Source>>(),
  cancel: vi.fn<() => void>(),
  load: vi.fn<(source: Source, opts: { start: number }) => Promise<void>>(),
  titleProgress: vi.fn<(profileId: number, contentId: string) => Promise<Progress[]>>(),
  pull: vi.fn<() => Promise<unknown>>(),
  openTorrent: vi.fn<(request: TorrentRequest) => Promise<Source>>(),
  torrentStatus: vi.fn<() => Promise<Status>>(),
  installed: vi.fn<() => Promise<Plugin[]>>(),
  pluginStreams: vi.fn<(plugin: Plugin, query: Query) => Promise<PluginStream[]>>(),
  device: vi.fn<() => Promise<DeviceSettings>>(),
  saveDevice: vi.fn<(settings: DeviceSettings) => Promise<void>>(),
  chosen: vi.fn<(profileId: number, contentId: string) => Promise<ChosenSource | null>>(),
  setChosen:
    vi.fn<(profileId: number, contentId: string, chosen: ChosenSource | null) => Promise<void>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: () => Promise.resolve([]),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: mocks.titleProgress,
    DeviceSettings: mocks.device,
    SaveDeviceSettings: mocks.saveDevice,
    ChosenSource: mocks.chosen,
    SetChosenSource: mocks.setChosen,
    ProfileSettings: () =>
      Promise.resolve({
        audioLanguages: [],
        subtitleLanguage: "",
        subtitleSize: "medium",
        captions: "system",
      }),
  },
}));

// A Wails call: a promise with cancel.
vi.mock("@bindings/streams", () => ({
  Service: {
    Resolve: (request: Request) => Object.assign(mocks.resolve(request), { cancel: mocks.cancel }),
  },
}));

// Plugins (#56): none installed unless a test says.
vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => mocks.installed(),
    Refresh: () => Promise.resolve(0),
    Streams: (plugin: Plugin, query: Query) =>
      Object.assign(mocks.pluginStreams(plugin, query), { cancel: mocks.cancel }),
  },
}));

vi.mock("@bindings/torrent", () => ({
  Service: {
    Open: (request: TorrentRequest) =>
      Object.assign(mocks.openTorrent(request), { cancel: mocks.cancel }),
    Status: mocks.torrentStatus,
    Release: () => Promise.resolve(),
  },
}));

vi.mock("@bindings/player", () => ({
  Service: {
    Load: mocks.load,
    Snapshot: () => Promise.reject(new Error("not playing")),
    Stop: () => Promise.resolve(),
    SetPaused: () => Promise.resolve(),
    SetFullscreen: () => Promise.resolve(),
    SetMini: () => Promise.resolve(),
    SetNowPlaying: () => Promise.resolve(),
  },
}));

// The player screen, once a picked stream is loaded.
const opensThePlayer = async () =>
  expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();

vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: mocks.pull,
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;
const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};
const torrentio: Addon = {
  url: "https://torrentio.strem.fun/manifest.json",
  name: "Torrentio",
  enabled: true,
};
const peerflix: Addon = {
  url: "https://peerflix.example/manifest.json",
  name: "Peerflix",
  enabled: true,
};

const movieStreams = (addon: string) => `https://${addon}/stream/movie/tt0111161.json`;
const pickerPath = "/streams/movie/tt0111161";

// An answer made afresh for each request.
class Each {
  constructor(readonly make: () => unknown) {}
}

// Answers addon requests by full URL: a body, a promise of one for an addon
// that answers when the test says, or Each. Anything else answers 503.
// Returns each request's URL and signal.
function serve(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [torrentio.url]: torrentioManifest,
    [peerflix.url]: peerflixManifest,
    "https://v3-cinemeta.strem.io/meta/movie/tt0111161.json": cinemetaMovie,
    "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
    ...answers,
  };
  const fetch = vi.fn<(url: string, init: { signal: AbortSignal }) => Promise<Response>>(
    async (url, init) => {
      // The Wails runtime's own calls (a binding no test mocks) come as a URL.
      if (typeof url !== "string" || !(url in all)) return new Response("", { status: 503 });
      const answer = all[url];
      const body = await Promise.race([
        answer instanceof Each ? answer.make() : answer,
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
      ]);
      return Response.json(body);
    },
  );
  vi.stubGlobal("fetch", fetch);
  return () =>
    fetch.mock.calls
      .filter(([url]) => typeof url === "string")
      .map(([url, init]) => ({ url, signal: init.signal }));
}

function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const streams = (count: number) => ({
  streams: Array.from({ length: count }, (_, i) => ({
    name: `Source\n${i}`,
    description: `Stream.${i}.mkv`,
    url: `https://debrid.example/KEY/${i}`,
  })),
});

// A Torrentio debrid stream: cached ("+") or not (" download").
const debrid = (file: string, marker: string) => ({
  name: `[TB${marker}] Torrentio\n1080p`,
  title: `${file}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/KEY/${marker === "+" ? "a" : "b"}${"0".repeat(39)}/null/0/${file}`,
});

// #98: a cached stream per resolution, so only the device decides.
const cachedAt = (resolution: "2160p" | "1080p") => {
  const file = `The.Shawshank.Redemption.1994.${resolution}.BluRay.x265-GRP.mkv`;
  return {
    name: `[TB+] Torrentio\n${resolution}`,
    title: `${file}\n👤 20 💾 ${resolution === "2160p" ? "14" : "2.1"} GB ⚙️ Tracker`,
    url: `https://torrentio.strem.fun/resolve/torbox/KEY/${resolution === "2160p" ? "c" : "d"}${"0".repeat(39)}/null/0/${file}`,
  };
};

const addonStatus = (name: string) =>
  within(screen.getByRole("list", { name: "Addons" })).getByRole("listitem", { name });
// With a plugin installed (#56), the list is the addons' and plugins'.
const pluginStatus = (name: string) =>
  within(screen.getByRole("list", { name: "Addons and plugins" })).getByRole("listitem", { name });
// The streams' own buttons: not group headings, not "File name".
const shownStreams = () =>
  within(screen.getByRole("list", { name: "Streams" }))
    .queryAllByRole("button")
    .filter((button) => !button.hasAttribute("aria-expanded"));
const topPick = () => shownStreams()[0]!;

const resolved = ({ url }: Request): Source => ({
  url: `${url}#cdn`,
  origin: url,
  headers: {},
  userAgent: "Peli/test",
  contentType: "video/x-matroska",
  size: 2_100_000_000,
});

// A torrent stream with no link, as Peerflix sends without a debrid service.
const p2p = {
  name: "Peerflix\n1080p",
  description: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv\n👤 59 💾 2.1 GB",
  infoHash: "9cf3225d39f3a46c34cc149101dd8560c574a21b",
  fileIdx: 2,
  sources: ["tracker:udp://open.stealth.si:80/announce"],
};

// What the device settings are until a test changes them (#98).
const device: DeviceSettings = {
  hardwareDecoding: true,
  maxResolution: "auto",
  hdr: "auto",
  dolbyVision: "auto",
  skipTimesOnline: true,
  autoUpdate: true,
  diagnostics: false,
  torrentStreaming: false,
  torrentCacheGB: 5,
  preResolve: false,
  streamSort: "best",
  partyDock: false,
  quality: defaultQuality,
  audio: defaultAudio,
};

beforeEach(() => {
  mocks.device.mockReset().mockResolvedValue(device);
  mocks.saveDevice.mockReset().mockResolvedValue(undefined);
  // The filters last for the session: each test starts with none.
  keepForSession(noFilters);
  mocks.resolve.mockImplementation(async (request) => resolved(request));
  mocks.openTorrent.mockReset();
  mocks.torrentStatus.mockReset().mockResolvedValue({
    active: true,
    ready: false,
    peers: 3,
    seeders: 1,
    downloadRate: 0,
    uploadRate: 0,
    ahead: 0,
    done: 0,
    size: 0,
  });
  mocks.load.mockResolvedValue(undefined);
  mocks.titleProgress.mockReset().mockResolvedValue([]);
  mocks.pull.mockReset().mockRejectedValue(new Error("offline"));
  mocks.current.mockResolvedValue(kevin);
  mocks.installed.mockReset().mockResolvedValue([]);
  mocks.pluginStreams.mockReset().mockResolvedValue([]);
  mocks.chosen.mockReset().mockResolvedValue(null);
  mocks.setChosen.mockReset().mockResolvedValue(undefined);
  mocks.addons.mockResolvedValue([cinemeta, torrentio, peerflix]);
  mocks.visibleAddons.mockResolvedValue([cinemeta, torrentio, peerflix]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream picker", () => {
  it("opens from Play and asks every stream addon at once, showing each as it answers", async () => {
    const slow = later<unknown>();
    const asked = serve({
      [movieStreams("torrentio.strem.fun")]: slow.promise,
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    // The first render in the file loads every route's code cold: allow it
    // longer than the shell wait renderApp gives.
    const { router } = await renderApp("/title/movie/tt0111161", { shell: false });
    await screen.findByRole("navigation", { name: "Main" }, { timeout: 15_000 });

    await user.click(await screen.findByRole("button", { name: "Play" }));
    expect(router.state.location.pathname).toBe(pickerPath);
    expect(
      await screen.findByRole("heading", { level: 1, name: "The Shawshank Redemption" }),
    ).toBeInTheDocument();

    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("12 streams"));
    expect(addonStatus("Torrentio")).toHaveTextContent("Asking…");
    // Peerflix sends one file twice: the count is after de-duplication (#51).
    expect(
      await screen.findByText(/11 streams, 1 of 2 addons still answering/),
    ).toBeInTheDocument();
    expect(shownStreams()).not.toHaveLength(0);
    // Both were asked before either answered; Cinemeta serves no streams.
    const streamUrls = asked()
      .map(({ url }) => url)
      .filter((url) => url.includes("/stream/"));
    expect(streamUrls.toSorted()).toEqual([
      movieStreams("peerflix.example"),
      movieStreams("torrentio.strem.fun"),
    ]);

    slow.resolve(streams(3));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("3 streams"));
    expect(await screen.findByText("14 streams from 2 addons")).toBeInTheDocument();
    // Torrentio's say nothing of their quality, so they rank last, in the
    // order they came.
    expect(screen.getByRole("heading", { name: "Unknown 3" })).toBeInTheDocument();
    expect(shownStreams().at(-1)).toHaveTextContent(/^Unknown qualityTorrentio$/);
  });

  it("isn't done while an addon's manifest is still loading", async () => {
    const manifest = later<unknown>();
    serve({
      [torrentio.url]: manifest.promise,
      [movieStreams("torrentio.strem.fun")]: streams(2),
      [movieStreams("peerflix.example")]: streams(1),
    });
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("1 stream"));
    expect(await screen.findByText("1 stream, still loading addons")).toBeInTheDocument();

    manifest.resolve(torrentioManifest);
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("2 streams"));
    expect(await screen.findByText("3 streams from 2 addons")).toBeInTheDocument();
  });

  it("asks for the episode, and the heading names it", async () => {
    const asked = serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Breaking Bad S1 · E1" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("12 streams"));
    expect(asked().filter(({ url }) => url.includes("/stream/"))).toHaveLength(2);
  });

  // #122: the header names the episode under the title.
  it("names the episode under the title", async () => {
    serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));

    expect(await screen.findByText("S1 · E1 · Pilot")).toBeInTheDocument();
  });

  it("shows a failed addon's reason and asks it again on Try again", async () => {
    const asked = serve({ [movieStreams("peerflix.example")]: peerflixMovie });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("answered 503"));
    expect(addonStatus("Peerflix")).toHaveTextContent("12 streams");

    serve({
      [movieStreams("torrentio.strem.fun")]: streams(2),
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    await user.click(within(addonStatus("Torrentio")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("2 streams"));
    expect(await screen.findByText("13 streams from 2 addons")).toBeInTheDocument();
    expect(asked().filter(({ url }) => url.includes("peerflix.example/stream"))).toHaveLength(1);
  });

  it("aborts the requests still out when the picker is left", async () => {
    const asked = serve({
      [movieStreams("torrentio.strem.fun")]: later().promise,
      [movieStreams("peerflix.example")]: later().promise,
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(asked().filter(({ url }) => url.includes("/stream/"))).toHaveLength(2),
    );
    const requests = asked().filter(({ url }) => url.includes("/stream/"));
    expect(requests.some(({ signal }) => signal.aborted)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt0111161"));
    await waitFor(() => expect(requests.every(({ signal }) => signal.aborted)).toBe(true));
  });

  it("lists a big answer without mounting every stream", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1400) });
    mocks.addons.mockResolvedValue([torrentio]);
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1400 streams"));
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0));
    expect(shownStreams().length).toBeLessThan(50);
    // Stream URLs carry the debrid key: never shown.
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("ranks the streams with the top pick first and likely fakes collapsed", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [
          debrid("The.Shawshank.Redemption.1994.720p.BluRay.x264-GRP.mkv", " download"),
          debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+"),
        ],
      },
      // Peerflix answers with Dune's streams: the wrong year for this film.
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    // In the list: the jump strip names the group too.
    const fakes = await within(await screen.findByRole("list", { name: "Streams" })).findByRole(
      "button",
      { name: /^Likely fake 8/ },
    );
    expect(fakes).toHaveAttribute("aria-expanded", "false");
    // Cached on debrid first, as the top pick, though it's not the best
    // picture.
    expect(topPick()).toHaveTextContent(/^Top pick1080pBlu-ray/);
    expect(topPick()).toHaveTextContent("Cached · TorBox");
    expect(shownStreams()).toHaveLength(5);

    await user.click(fakes);
    expect(fakes).toHaveAttribute("aria-expanded", "true");
    expect(shownStreams()).toHaveLength(13);
    expect(screen.getAllByText("Another year’s release")).toHaveLength(8);
    await user.click(fakes);
    expect(shownStreams()).toHaveLength(5);
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("ranks again, with the pick and the groups moved, when a device setting changes", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [cachedAt("1080p"), cachedAt("2160p")],
      },
    });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    const { queryClient } = await renderApp(pickerPath);

    // No cap: the 4K stream is the top pick, and its group comes first.
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick4K/));
    expect(shownStreams().at(-1)).toHaveTextContent("1080p");

    // A 1080p cap, set while the picker is open (Settings saves it the same
    // way): the 1080p stream is the pick, and 4K is listed after it.
    act(() => {
      queryClient.setQueryData(deviceSettingsQuery.queryKey, { ...device, maxResolution: "1080p" });
    });
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick1080p/));
    expect(shownStreams().at(-1)).toHaveTextContent("4K");

    // Back to Auto: 4K is first again.
    act(() => {
      queryClient.setQueryData(deviceSettingsQuery.queryKey, { ...device, maxResolution: "auto" });
    });
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick4K/));
  });

  it("asks every enabled addon, even ones a kids profile doesn't browse", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    mocks.addons.mockResolvedValue([cinemeta, torrentio, { ...peerflix, enabled: false }]);
    const asked = serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1 stream"));
    expect(screen.queryByRole("listitem", { name: "Peerflix" })).toBeNull();
    expect(asked().some(({ url }) => url.includes("peerflix"))).toBe(false);
  });

  it("says so when no addon serves streams for the title", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);
    serve();
    await renderApp(pickerPath);

    expect(
      await screen.findByRole("heading", { name: "No addon has streams for this" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage addons" })).toBeInTheDocument();
  });

  it("asks plugins by TMDB id beside the addons, ranks their streams with the rest, and plays one with its headers", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    const plugin: Plugin = {
      id: "site",
      name: "Site Plugin",
      version: "1.0.0",
      url: "https://plugins.example/site.js",
      supportedTypes: ["movie", "tv"],
    };
    mocks.installed.mockResolvedValue([plugin]);
    mocks.pluginStreams.mockResolvedValue([
      {
        name: "Site",
        title: "The.Shawshank.Redemption.1994.1080p.WEB-DL.mkv",
        url: "https://cdn.site.example/master.m3u8",
        quality: "1080p",
        size: "2.1 GB",
        headers: { Referer: "https://site.example/" },
      },
    ]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(pluginStatus("Site Plugin")).toHaveTextContent("1 stream"));
    // By the TMDB id in Cinemeta's details.
    expect(mocks.pluginStreams).toHaveBeenCalledExactlyOnceWith(plugin, {
      tmdbId: "278",
      mediaType: "movie",
      season: 0,
      episode: 0,
    });
    expect(await screen.findByText("2 streams from 2 sources")).toBeInTheDocument();
    // Its 1080p ranks above Torrentio's stream of no known quality.
    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      url: "https://cdn.site.example/master.m3u8",
      headers: { Referer: "https://site.example/" },
    });
  });

  it("shows a plugin that failed, and asks it again on Try again", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.installed.mockResolvedValue([
      {
        id: "slow",
        name: "Slow Plugin",
        version: "1",
        url: "https://plugins.example/slow.js",
        supportedTypes: [],
      },
    ]);
    mocks.pluginStreams.mockRejectedValueOnce(new Error("timeout", { cause: { code: "timeout" } }));
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() =>
      expect(pluginStatus("Slow Plugin")).toHaveTextContent("The plugin didn’t answer."),
    );
    await user.click(
      within(pluginStatus("Slow Plugin")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(pluginStatus("Slow Plugin")).toHaveTextContent("0 streams"));
    expect(mocks.pluginStreams).toHaveBeenCalledTimes(2);
  });

  it("resolves a picked stream's link and plays it", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [
          {
            ...streams(1).streams[0],
            behaviorHints: { proxyHeaders: { request: { Referer: "https://addon.example/" } } },
          },
        ],
      },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      url: "https://debrid.example/KEY/0",
      headers: { Referer: "https://addon.example/" },
    });
    // In the profile's languages and subtitle size (#62), keeping the
    // film's progress (#64).
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(await mocks.resolve.mock.results[0]!.value, {
      start: 0,
      audioLanguages: [],
      subtitleLanguage: "",
      captions: "system",
      subtitleSize: "medium",
      watching: {
        profileId: 1,
        contentId: "tt0111161",
        contentType: "movie",
        videoId: "tt0111161",
        title: "The Shawshank Redemption",
        // For SIMKL and AniList (#73).
        name: "The Shawshank Redemption",
        year: 1994,
        ids: { imdb: "tt0111161", tmdb: "278" },
      },
    });
    // Named from the title's details, not the picker's fallback heading.
    expect(screen.getByRole("heading", { name: "The Shawshank Redemption" })).toBeInTheDocument();
  });

  it("plays from where the store says it was left, pulling while the user picks", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    // Another device got further than the card that opened the picker knew.
    const left: Progress = {
      key: "tt0111161",
      contentId: "tt0111161",
      contentType: "movie",
      videoId: "tt0111161",
      position: 1_234_000,
      duration: 8_520_000,
      lastWatched: 2,
    };
    mocks.titleProgress.mockResolvedValue([left]);
    const user = userEvent.setup();
    await renderApp(`${pickerPath}?at=600000`);

    await waitFor(() => expect(mocks.pull).toHaveBeenCalled());
    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    await opensThePlayer();
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ start: 1234 }),
    );
  });

  it("starts from the beginning when the store has it watched to 90 %", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.titleProgress.mockResolvedValue([
      {
        key: "tt0111161",
        contentId: "tt0111161",
        contentType: "movie",
        videoId: "tt0111161",
        position: 8_000_000,
        duration: 8_520_000,
        lastWatched: 2,
      },
    ]);
    const user = userEvent.setup();
    await renderApp(`${pickerPath}?at=8000000`);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    await opensThePlayer();
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ start: 0 }),
    );
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });

  it("keeps an episode's progress under its season and number", async () => {
    serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    // Torrentio without a debrid service: the pick streams peer to peer.
    mocks.openTorrent.mockImplementation(async ({ infoHash }) =>
      resolved({ url: infoHash, headers: {} }),
    );
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("12 streams"));
    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        start: 0,
        watching: expect.objectContaining({
          profileId: 1,
          contentId: "tt0903747",
          contentType: "series",
          videoId: "tt0903747:1:1",
          season: 1,
          episode: 1,
          title: "Pilot",
        }),
      }),
    );
  });

  it("says so when the player can't start", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.load.mockRejectedValue(new Error("call failed", { cause: { code: "unavailable" } }));
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    expect(await screen.findByText("Can’t play Streams")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("says why a stream won't play, naming its debrid service", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", " download")],
      },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockRejectedValue(new Error("call failed", { cause: { code: "caching" } }));
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Not cached · TorBox"));
    await user.click(topPick());
    expect(await screen.findByText("TorBox is still downloading this")).toBeInTheDocument();
    expect(screen.getByText(/Pick a cached stream to watch now/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("streams a torrent peer to peer, saying how it's going", async () => {
    serve({ [movieStreams("peerflix.example")]: { streams: [p2p] } });
    mocks.addons.mockResolvedValue([peerflix]);
    const opened = later<Source>();
    mocks.openTorrent.mockReturnValue(opened.promise);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("P2P"));
    await user.click(topPick());
    expect(
      await screen.findByText("Getting the file list from 3 peers…", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(mocks.openTorrent).toHaveBeenCalledExactlyOnceWith({
      infoHash: p2p.infoHash,
      fileIdx: 2,
      fileName: "",
      sources: p2p.sources,
    });

    const source: Source = {
      url: "http://127.0.0.1:50123/secret/hash/2/film.mkv",
      origin: `magnet:?xt=urn:btih:${p2p.infoHash}`,
      headers: {},
      userAgent: "",
      contentType: "video/x-matroska",
      size: 2_100_000_000,
    };
    opened.resolve(source);
    await opensThePlayer();
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      source,
      expect.objectContaining({ start: 0 }),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("says torrent streaming is off, with a way to Settings", async () => {
    serve({ [movieStreams("peerflix.example")]: { streams: [p2p] } });
    mocks.addons.mockResolvedValue([peerflix]);
    mocks.openTorrent.mockRejectedValue(new Error("call failed", { cause: { code: "disabled" } }));
    const user = userEvent.setup();
    const { router } = await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("P2P"));
    await user.click(topPick());
    expect(await screen.findByText("Torrent streaming is off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    // The Streaming pane has the torrent setting.
    expect(router.state.location.search).toEqual({ section: "streaming" });
  });

  it("asks the addon again for a link that has expired", async () => {
    let asked = 0;
    serve({
      [movieStreams("torrentio.strem.fun")]: new Each(() => {
        asked += 1;
        return {
          streams: [
            {
              ...debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+"),
              url: `https://torrentio.strem.fun/resolve/torbox/KEY/link-${asked}`,
            },
          ],
        };
      }),
    });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockImplementation(async (request) => {
      if (request.url.endsWith("link-1")) {
        throw new Error("call failed", { cause: { code: "expired" } });
      }
      return resolved(request);
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.resolve.mock.calls.map(([request]) => request.url)).toEqual([
      "https://torrentio.strem.fun/resolve/torbox/KEY/link-1",
      "https://torrentio.strem.fun/resolve/torbox/KEY/link-2",
    ]);
  });

  it("stops resolving when the picker is left", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockReturnValue(later<Source>().promise);
    const user = userEvent.setup();
    const { router } = await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Play" }));

    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    await user.click(topPick());
    expect(await screen.findByText("Opening the stream from Torrentio…")).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt0111161"));
    expect(mocks.cancel).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByText("Opening the stream from Torrentio…")).toBeNull(),
    );
  });

  it("plays the top pick with P, from anywhere on the picker", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+")],
      },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await user.keyboard("p");
    await opensThePlayer();
    // Torrentio's cached 1080p, not Peerflix's torrent.
    expect(mocks.resolve.mock.calls[0]![0].url).toMatch(
      /^https:\/\/torrentio\.strem\.fun\/resolve\/torbox\//,
    );
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("shows a stream's file name only when asked", async () => {
    const file = "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv";
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [debrid(file, "+")] } });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    expect(screen.queryByText(file)).toBeNull();
    const button = within(screen.getByRole("list", { name: "Streams" })).getByRole("button", {
      name: "File name",
    });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(file)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("KEY");

    // I, on the row, hides it again.
    topPick().focus();
    await user.keyboard("i");
    expect(screen.queryByText(file)).toBeNull();
  });

  it("cancels the resolve from the Opening message and leaves the picker as it was", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockReturnValue(later<Source>().promise);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    await user.click(topPick());
    expect(await screen.findByText("Opening the stream from Torrentio…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Opening the stream from Torrentio…")).toBeNull(),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(shownStreams()).toHaveLength(1);
    // Picking again opens it afresh.
    await user.click(topPick());
    expect(await screen.findByText("Opening the stream from Torrentio…")).toBeInTheDocument();
  });

  it("tells a stream's codec and an estimated bitrate from its size and the runtime", async () => {
    const file = "The.Shawshank.Redemption.1994.1080p.BluRay.x265-GRP.mkv";
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [debrid(file, "+")] } });
    mocks.addons.mockResolvedValue([torrentio]);
    await renderApp(pickerPath);

    // 2.1 GB over the film's 142 minutes. The addon's GB is 2³⁰ bytes, the
    // label's 10⁹.
    await waitFor(() => expect(topPick()).toHaveTextContent("HEVC"));
    expect(topPick()).toHaveTextContent(`${gb(2.1)} · ~2.1 Mbps`);
  });

  it("copies a stream's parsed file names, never its link", async () => {
    const file = "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv";
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [debrid(file, "+")] } });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    // The names show on asking, and carry the copy button.
    await user.click(screen.getByRole("button", { name: "File name" }));
    await user.click(await screen.findByRole("button", { name: "Copy file name" }));

    // user-event's clipboard stands in for the system's.
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain(file);
    expect(copied).not.toContain("KEY");
    expect(copied).not.toContain("https://");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("asks every failed addon again with Try all again, once two have failed", async () => {
    const asked = serve();
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("answered 503"));
    const before = asked().filter(({ url }) => url.includes("/stream/")).length;
    await user.click(screen.getByRole("button", { name: "Try all again" }));
    await waitFor(() =>
      expect(asked().filter(({ url }) => url.includes("/stream/")).length).toBe(before + 2),
    );
  });

  it("offers no Try all again while one addon failed", async () => {
    serve({ [movieStreams("peerflix.example")]: peerflixMovie });
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("answered 503"));
    expect(screen.queryByRole("button", { name: "Try all again" })).toBeNull();
  });

  it("steps to the previous and next episode from the header", async () => {
    serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A2.json": torrentioSeries,
    });
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E2/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Breaking Bad S1 · E2" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous episode, S1 · E1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next episode, S1 · E3" }));
    expect(await screen.findByText(/^S1 · E3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous episode, S1 · E2" })).toBeInTheDocument();
  });

  it("has no episode buttons for a film", async () => {
    serve({ [movieStreams("peerflix.example")]: peerflixMovie });
    await renderApp(pickerPath);

    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: "Episodes" })).toBeNull();
  });

  it("moves through the list with the arrow keys, Home and End, and plays with Enter", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+")],
      },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    // The list is one Tab stop, at the top pick.
    const list = screen.getByRole("list", { name: "Streams" });
    const stop = within(list)
      .getAllByRole("button")
      .find((button) => button.tabIndex === 0);
    expect(stop).toBe(topPick());

    topPick().focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(shownStreams()[1]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(topPick());
    // End reaches the collapsed group's heading; Enter opens it.
    await user.keyboard("{End}");
    const fakes = within(screen.getByRole("list", { name: "Streams" })).getByRole("button", {
      name: /^Likely fake 8/,
    });
    expect(document.activeElement).toBe(fakes);
    await user.keyboard("{Enter}");
    expect(fakes).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(topPick());
    await user.keyboard("{Enter}");
    await opensThePlayer();
  });

  it("keeps the top pick once the user moves into the list", async () => {
    const slow = later<unknown>();
    serve({
      [movieStreams("torrentio.strem.fun")]: slow.promise,
      [movieStreams("peerflix.example")]: {
        streams: [
          {
            name: "Peerflix 1080p",
            description: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv\n👤 40 💾 9.6 GB",
            infoHash: "a".repeat(40),
          },
        ],
      },
    });
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("P2P · 40 seeders"));
    // Moving into the list (here, onto the row's file name button) pins it.
    act(() => topPick().focus());

    // A better one arrives: cached on debrid. It's listed, but below.
    slow.resolve({
      streams: [debrid("The.Shawshank.Redemption.1994.2160p.BluRay.x265-GRP.mkv", "+")],
    });
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1 stream"));
    await waitFor(() => expect(shownStreams()).toHaveLength(2));
    expect(topPick()).toHaveTextContent("P2P · 40 seeders");
    expect(shownStreams()[1]).toHaveTextContent("Cached · TorBox");
  });
  // #58: the show's last source on top, and what plays remembered.
  it("puts the source the show last played from on top, and remembers what plays", async () => {
    serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.chosen.mockResolvedValue({
      source: torrentio.url,
      resolution: "1080p",
      group: "PSA",
      chosenAt: 1,
    });
    mocks.openTorrent.mockImplementation(async ({ infoHash }) =>
      resolved({ url: infoHash, headers: {} }),
    );
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("12 streams"));
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick·Same source as last time/));
    expect(mocks.chosen).toHaveBeenCalledWith(1, "tt0903747");
    expect(shownStreams()[1]).not.toHaveTextContent("Same source as last time");

    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.setChosen).toHaveBeenCalledExactlyOnceWith(1, "tt0903747", {
      source: torrentio.url,
      resolution: "1080p",
      group: "PSA",
      chosenAt: expect.any(Number),
    });
  });

  it("remembers another stream the user picks instead, from then on", async () => {
    serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.chosen.mockResolvedValue({
      source: torrentio.url,
      resolution: "1080p",
      group: "PSA",
      chosenAt: 1,
    });
    mocks.openTorrent.mockImplementation(async ({ infoHash }) =>
      resolved({ url: infoHash, headers: {} }),
    );
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));
    await waitFor(() => expect(topPick()).toHaveTextContent("Same source as last time"));
    await user.click(shownStreams()[1]!);
    await opensThePlayer();
    expect(mocks.setChosen).toHaveBeenCalledExactlyOnceWith(
      1,
      "tt0903747",
      expect.objectContaining({ source: torrentio.url }),
    );
    expect(mocks.setChosen.mock.calls[0]![2]!.group).not.toBe("PSA");
  });

  it("keeps no source for a film", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.chosen).not.toHaveBeenCalled();
    expect(mocks.setChosen).not.toHaveBeenCalled();
  });
});

// What the host plays, as the party names it.
// The toolbar's chips, by facet and name ("4K 1").
const chip = (facet: string, name: RegExp) =>
  within(screen.getByRole("group", { name: facet })).getByRole("button", { name });
const jumpStrip = () => screen.getByRole("navigation", { name: "Stream groups" });

// A Torrentio debrid stream of the film at a resolution and size.
const shawshankAt = (resolution: string, size: string, marker = "+", letter = "f") => ({
  name: `[TB${marker}] Torrentio\n${resolution}`,
  title: `The.Shawshank.Redemption.1994.${resolution}.BluRay.x265-GRP.mkv\n👤 20 💾 ${size} ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/KEY/${letter}${"0".repeat(39)}/null/0/${resolution}-${size}.mkv`,
});
// What a size an addon writes as "n GB" (n × 2³⁰ bytes) shows as.
const gb = (n: number) => sizeLabel(Math.round(n * 2 ** 30))!;
// The rows' sizes, in order.
const sizes = () => shownStreams().map((row) => /([\d.]+ GB)/.exec(row.textContent ?? "")?.[1]);

describe("filters, sorts and the jump strip", () => {
  it("filters with chips that count, and the top pick and P follow them", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cachedAt("2160p"), cachedAt("1080p")] },
      [movieStreams("peerflix.example")]: { streams: [p2p] },
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick4K/));
    // Plays now: two cached, one P2P. CAM / TS and fakes would not count.
    expect(chip("Plays now", /^Cached 2/)).toHaveAttribute("aria-pressed", "false");
    expect(chip("Plays now", /^P2P 1/)).toBeInTheDocument();
    // Every stream is SDR Blu-ray x265 or x264: no HDR chips.
    expect(screen.queryByRole("group", { name: "HDR" })).toBeNull();

    await user.click(chip("Resolution", /^1080p 2/));
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick·1080p only1080p/));
    expect(shownStreams()).toHaveLength(2);
    expect(screen.getByText(/^2 of 3 streams/)).toBeInTheDocument();
    // Counted with the resolution filter on.
    expect(chip("Plays now", /^Cached 1/)).toBeInTheDocument();

    await user.keyboard("p");
    await opensThePlayer();
    expect(mocks.resolve.mock.calls[0]![0].url).toBe(cachedAt("1080p").url);
  });

  it("searches the release names, and says when nothing matches, with a way back", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cachedAt("2160p"), cachedAt("1080p")] },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams()).toHaveLength(2));

    const search = screen.getByRole("searchbox", { name: "Search release names" });
    await user.type(search, "2160p x265");
    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    expect(topPick()).toHaveTextContent(/^Top pick·“2160p x265” only4K/);
    // Typing P in the search box doesn't play.
    expect(mocks.resolve).not.toHaveBeenCalled();

    await user.clear(search);
    await user.type(search, "remux");
    expect(await screen.findByText("No streams match")).toBeInTheDocument();
    expect(shownStreams()).toHaveLength(0);
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(clear.at(-1)!);
    await waitFor(() => expect(shownStreams()).toHaveLength(2));
    expect(search).toHaveValue("");
    expect(screen.queryByText("No streams match")).toBeNull();
  });

  it("keeps only an addon's streams when its chip is pressed", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cachedAt("1080p")] },
      [movieStreams("peerflix.example")]: { streams: [p2p] },
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams()).toHaveLength(2));

    const peerflixChip = within(addonStatus("Peerflix")).getByRole("button", { pressed: false });
    await user.click(peerflixChip);
    expect(peerflixChip).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    expect(topPick()).toHaveTextContent(/^Top pick·Peerflix only/);
    expect(topPick()).toHaveTextContent("P2P · 59 seeders");
    await user.click(peerflixChip);
    await waitFor(() => expect(shownStreams()).toHaveLength(2));
  });

  it("sorts within each group, keeping the groups, and saves the sort for the device", async () => {
    mocks.device.mockResolvedValue({ ...device, streamSort: "size-asc" });
    // What's saved is what the next read returns, as the store does.
    mocks.saveDevice.mockImplementation(async (settings) => {
      mocks.device.mockResolvedValue(settings);
    });
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [
          shawshankAt("1080p", "9.1 GB", "+", "a"),
          shawshankAt("1080p", "2.2 GB", " download", "b"),
          shawshankAt("1080p", "5.5 GB", " download", "c"),
          shawshankAt("2160p", "30 GB", " download", "d"),
        ],
      },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(shownStreams()).toHaveLength(4));
    // The top pick is still the best match; the rest of 1080p, smallest first.
    expect(topPick()).toHaveTextContent(gb(9.1));
    expect(sizes()).toEqual([gb(9.1), gb(30), gb(2.2), gb(5.5)]);
    // No P2P streams: no "Most seeders".
    await user.click(screen.getByRole("combobox", { name: "Sort" }));
    await screen.findByRole("option", { name: "Largest first" });
    expect(screen.queryByRole("option", { name: "Most seeders" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "Largest first" }));
    await waitFor(() =>
      expect(mocks.saveDevice).toHaveBeenCalledWith(
        expect.objectContaining({ streamSort: "size-desc" }),
      ),
    );
    await waitFor(() => expect(sizes()).toEqual([gb(9.1), gb(30), gb(5.5), gb(2.2)]));
  });

  it("jumps to a group from the strip or with the number keys", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [cachedAt("2160p"), cachedAt("1080p")],
      },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick4K/));

    const strip = within(jumpStrip()).getAllByRole("button");
    // The top pick, a group per quality, and the collapsed fakes last.
    expect(strip[0]).toHaveTextContent(/^Top pick/);
    expect(strip.at(-1)).toHaveTextContent(/^Likely fake 8/);
    expect(strip[0]).toHaveAttribute("aria-current", "location");
    expect(strip[1]).toHaveAttribute("aria-keyshortcuts", "2");

    // 2: the first group after the top pick, whose first stream takes focus.
    await user.keyboard("2");
    await waitFor(() => expect(document.activeElement).toBe(shownStreams()[1]));
    // The last key: the collapsed group's heading.
    await user.keyboard(String(strip.length));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByRole("list", { name: "Streams" })).getByRole("button", {
          name: /^Likely fake 8/,
        }),
      ),
    );
    // A click does the same, and 1 is the top pick.
    await user.click(strip[0]!);
    await waitFor(() => expect(document.activeElement).toBe(topPick()));
    // Typing a number in the search box jumps nowhere.
    await user.type(screen.getByRole("searchbox", { name: "Search release names" }), "2");
    expect(document.activeElement).toHaveAttribute("type", "search");
  });

  it("keeps the filters for the session, but not the search", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cachedAt("2160p"), cachedAt("1080p")] },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    const first = await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams()).toHaveLength(2));
    await user.click(chip("Resolution", /^4K 1/));
    await user.type(screen.getByRole("searchbox", { name: "Search release names" }), "x265");
    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    first.unmount();

    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    expect(chip("Resolution", /^4K 1/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("searchbox", { name: "Search release names" })).toHaveValue("");
  });
});

const partySource = {
  infoHash: "",
  fileIdx: null,
  filename: "Party.File.mkv",
  videoSize: 0,
  bingeGroup: "",
  addonId: "",
  name: "",
};

// Longer than the ranking takes to settle (500 ms) and then some.
const looking = () => new Promise((r) => setTimeout(r, 900));

// "Start cached streams sooner" (#101, ADR-0060): the cached top pick
// resolves while the user looks, so picking it plays at once.
describe("starting cached streams sooner", () => {
  const shawshank = "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv";
  const cached = debrid(shawshank, "+");

  it("resolves the cached top pick ahead, and plays it with P without asking again", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cached] },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce(), { timeout: 4000 });
    expect(mocks.resolve.mock.calls[0]![0].url).toBe(cached.url);
    expect(mocks.load).not.toHaveBeenCalled();

    await user.keyboard("p");
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.load.mock.calls[0]![0]).toEqual(resolved({ url: cached.url, headers: {} }));
  });

  it("resolves nothing ahead while the setting is off", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [cached] } });
    await renderApp(pickerPath);
    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await looking();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("resolves no uncached or torrent top pick ahead", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [debrid(shawshank, " download")] },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    await renderApp(pickerPath);
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1 stream"));
    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("12 streams"));
    await looking();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("waits for every addon to answer", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    const slow = later<unknown>();
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cached] },
      [movieStreams("peerflix.example")]: slow.promise,
    });
    await renderApp(pickerPath);
    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await looking();
    expect(mocks.resolve).not.toHaveBeenCalled();
    slow.resolve(peerflixMovie);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce(), { timeout: 4000 });
  });

  it("resolves nothing ahead on a kids profile", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [cached] } });
    await renderApp(pickerPath);
    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await looking();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("resolves the filtered top pick ahead once the filters settle", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    serve({
      [movieStreams("torrentio.strem.fun")]: { streams: [cachedAt("2160p"), cachedAt("1080p")] },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce(), { timeout: 4000 });
    expect(mocks.resolve.mock.calls[0]![0].url).toBe(cachedAt("2160p").url);

    // On and off and on again, quickly: one resolve, for where it settles.
    const fourK = within(screen.getByRole("group", { name: "Resolution" })).getByRole("button", {
      name: /^4K/,
    });
    const hd = within(screen.getByRole("group", { name: "Resolution" })).getByRole("button", {
      name: /^1080p/,
    });
    await user.click(hd);
    await user.click(hd);
    await user.click(fourK);
    await user.click(fourK);
    await user.click(hd);
    await waitFor(() => expect(topPick()).toHaveTextContent(/^Top pick·1080p only/));
    expect(mocks.resolve).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(mocks.resolve.mock.calls[1]![0].url).toBe(cachedAt("1080p").url);
    await looking();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it("resolves another stream the user picks when it's picked", async () => {
    mocks.device.mockResolvedValue({ ...device, preResolve: true });
    const other = debrid("The.Shawshank.Redemption.1994.720p.BluRay.x264-GRP.mkv", "+");
    other.name = "[TB+] Torrentio\n720p";
    other.url = other.url.replace("/a000", "/e000");
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [cached, other] } });
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce(), { timeout: 4000 });

    const second = shownStreams().find((button) => button.textContent?.includes("720p"));
    await user.click(second!);
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve.mock.calls[1]![0].url).toBe(other.url);
    expect(mocks.load.mock.calls[0]![0]).toEqual(resolved({ url: other.url, headers: {} }));
  });
});

describe("with a watch party", () => {
  const answer = {
    streams: [
      {
        name: "Source\nA",
        url: "https://debrid.example/KEY/a",
        behaviorHints: { filename: "Other.mkv" },
      },
      {
        name: "Source\nB",
        url: "https://debrid.example/KEY/b",
        behaviorHints: { filename: "party.file.mkv" },
      },
    ],
  };

  it("offers the host's file, and starts it where the party is", async () => {
    vi.mocked(Party.State).mockResolvedValueOnce(partyState({}, { source: partySource }));
    vi.mocked(Party.StartAt).mockResolvedValueOnce(754);
    serve({ [movieStreams("torrentio.strem.fun")]: answer });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    expect(await screen.findByText("Watching with Ana’s party")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play Ana’s stream" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Play the party’s source" }));
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://debrid.example/KEY/b" }),
    );
    expect(mocks.load).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ start: 754 }),
    );
  });

  it("plays the host's own link when they share it", async () => {
    vi.mocked(Party.State).mockResolvedValueOnce(
      partyState(
        {
          shared: {
            mediaKey: "movie|tt0111161||",
            url: "https://cdn.example/host.mkv",
            headers: { X: "y" },
            responseHeaders: {},
            name: "Host 4K",
            description: "",
            addonName: "",
            addonId: "",
            addonLogo: "",
            filename: "",
            videoSize: 0,
            bingeGroup: "",
            sharedBy: "Ana",
          },
        },
        { source: partySource },
      ),
    );
    serve({ [movieStreams("torrentio.strem.fun")]: answer });
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await user.click(await screen.findByRole("button", { name: "Play Ana’s stream" }));
    await opensThePlayer();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://cdn.example/host.mkv", headers: { X: "y" } }),
      expect.objectContaining({ start: 0 }),
    );
  });
});
