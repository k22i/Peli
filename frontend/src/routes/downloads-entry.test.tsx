import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import type { AddRequest } from "@bindings/downloads";
import type {
  Addon,
  ChosenSource,
  DeviceSettings,
  Download,
  Profile,
  ProfileSettings,
  Progress,
} from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import peerflixManifest from "@/lib/addon-protocol/fixtures/peerflix/manifest.json";
import torrentioManifest from "@/lib/addon-protocol/fixtures/torrentio/manifest.json";
import { defaultQuality } from "@/lib/quality";
import { defaultAudio } from "@/lib/sound";
import { profileSettings as settingsOf } from "@/test/fixtures";
import { renderApp } from "@/test/render-app";

// Downloading from where a title shows (#85, ADR-0064): the title page, a
// season's menu, an episode's menu and the picker's rows. Go takes the
// request; the frontend ranks the streams and hands it the best one with a
// link.

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visible: vi.fn<() => Promise<Addon[] | null>>(),
  chosen: vi.fn<(profileId: number, contentId: string) => Promise<ChosenSource | null>>(),
  device: vi.fn<() => Promise<DeviceSettings>>(),
  profileSettings: vi.fn<(profileId: number) => Promise<ProfileSettings>>(),
  titleProgress: vi.fn<() => Promise<Progress[]>>(),
  // The downloads binding: what the screen asks, and what it adds or deletes.
  add: vi.fn<(request: AddRequest) => Promise<unknown>>(),
  list: vi.fn<(profileId: number) => Promise<Download[] | null>>(),
  remove: vi.fn<(profileId: number, ids: string[] | null) => Promise<void>>(),
  // The tray's shared flag: a row's "Show downloads" opens it.
  openTray: vi.fn<() => void>(),
}));

// A Wails call: a CancellablePromise, which carries the cancel() the bindings'
// calls have.
function cancels<T>(value: T) {
  return CancellablePromise.resolve(value);
}

vi.mock("@bindings/downloads", () => {
  return {
    Service: {
      Add: (request: AddRequest) => cancels(mocks.add(request)),
      ChooseFolder: () => cancels(""),
      Delete: (profileId: number, ids: string[] | null) => cancels(mocks.remove(profileId, ids)),
      DeleteAll: () => cancels(undefined),
      Get: () => cancels(null),
      List: (profileId: number) => cancels(mocks.list(profileId)),
      Network: () => cancels({ online: true, expensive: false }),
      Pause: () => cancels(undefined),
      Playable: () => cancels(null),
      Resume: () => cancels(undefined),
      Usage: () => cancels({ used: 0, cap: 50e9, free: 100e9, dir: "/tmp/Peli/Downloads" }),
    },
  };
});

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((profile) => [profile]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visible,
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: () => Promise.resolve([]),
    LastWatched: () => Promise.resolve({}),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: mocks.titleProgress,
    // The title page's other edits: only the download ones are used here.
    SetWatched: () => Promise.resolve(),
    SaveLibraryItem: () => Promise.resolve(),
    RemoveLibraryItem: () => Promise.resolve(),
    RemoveProgress: () => Promise.resolve(),
    SaveProgress: (_profileId: number, entry: Progress) => Promise.resolve(entry),
    ClearContinueWatching: () => Promise.resolve(),
    DeviceSettings: mocks.device,
    SaveDeviceSettings: () => Promise.resolve(),
    ProfileSettings: mocks.profileSettings,
    ChosenSource: mocks.chosen,
    SetChosenSource: () => Promise.resolve(),
  },
}));

vi.mock("@/lib/download-tray", () => ({
  openDownloadTray: mocks.openTray,
  setDownloadTrayOpen: vi.fn<(open: boolean) => void>(),
  useDownloadTrayOpen: () => false,
}));

vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
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

const base = "https://v3-cinemeta.strem.io";
const moviePath = "/title/movie/tt0111161";
const seriesPath = "/title/series/tt0903747";
const pickerPath = "/streams/movie/tt0111161?video=tt0111161";

const movieStreams = (host: string) => `https://${host}/stream/movie/tt0111161.json`;
const seriesStreams = (host: string, video: string) =>
  `https://${host}/stream/series/${encodeURIComponent(video)}.json`;

// A Torrentio-style debrid stream: a link Go can fetch.
const debrid = (file: string) => ({
  name: "[TB+] Torrentio\n1080p",
  title: `${file}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/KEY/${file.length}${"0".repeat(39)}/null/0/${file}`,
});

// A torrent with no link: Peli can't download it (ADR-0064).
const p2p = {
  name: "Peerflix\n1080p",
  description: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv\n👤 59 💾 2.1 GB",
  infoHash: "9cf3225d39f3a46c34cc149101dd8560c574a21b",
  fileIdx: 2,
  sources: ["tracker:udp://open.stealth.si:80/announce"],
};

const movieFile = "The.Shawshank.Redemption.1994.1080p.BluRay.x265-GRP.mkv";
const linked = debrid(movieFile);
const episodeFile = (season: number, episode: number) =>
  `Breaking.Bad.S0${season}E0${episode}.1080p.WEB-DL-NTb.mkv`;

// Answers addon requests by full URL; anything else answers 503.
function serve(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [torrentio.url]: torrentioManifest,
    [peerflix.url]: peerflixManifest,
    [`${base}/meta/movie/tt0111161.json`]: cinemetaMovie,
    [`${base}/meta/series/tt0903747.json`]: cinemetaSeries,
    [movieStreams("torrentio.strem.fun")]: { streams: [linked] },
    ...answers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      typeof url === "string" && url in all
        ? Response.json(all[url])
        : new Response("", { status: 503 }),
    ),
  );
}

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
  downloadsDir: "",
  downloadsCapGB: 50,
  downloadsWiFiOnly: true,
  quality: defaultQuality,
  audio: defaultAudio,
  subtitles: {
    always: false,
    style: {
      font: "sans",
      size: 100,
      color: "#FFFFFF",
      bold: false,
      edge: "outline",
      backdrop: 60,
      lift: 0,
      override: false,
    },
  },
};

// The profile's settings as Go keeps them, with no subtitle language: a
// download goes without subtitles unless a test asks for them.
const profileSettings = settingsOf();

// A record as Go keeps it, for one of a title's videos.
const record = (over: Partial<Download> = {}): Download => ({
  id: "0123456789abcdef0123456789abcdef",
  profileId: 1,
  contentId: "tt0111161",
  contentType: "movie",
  videoId: "tt0111161",
  season: 0,
  episode: 0,
  name: "The Shawshank Redemption",
  episodeName: "",
  poster: "",
  metaAddon: cinemeta.url,
  streamSource: torrentio.url,
  streamName: "Torrentio",
  streamDescription: "",
  resolution: "1080p",
  request: { url: linked.url, headers: null },
  root: "",
  file: "video.mkv",
  mimeType: "video/x-matroska",
  subtitles: null,
  segments: null,
  state: "done",
  reason: "",
  bytes: 2_100_000_000,
  total: 2_100_000_000,
  createdAt: 1,
  updatedAt: 2,
  doneAt: 3,
  ...over,
});

const episodeRecord = (season: number, episode: number): Download =>
  record({
    contentId: "tt0903747",
    contentType: "series",
    videoId: `tt0903747:${season}:${episode}`,
    season,
    episode,
    name: "Breaking Bad",
    episodeName: `Episode ${episode}`,
  });

// The streams' own buttons: not group headings, not "File name".
const shownStreams = () =>
  within(screen.getByRole("list", { name: "Streams" }))
    .queryAllByRole("button")
    .filter((button) => !button.hasAttribute("aria-expanded"));
const topPick = () => shownStreams()[0]!;

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta, torrentio]);
  mocks.visible.mockResolvedValue([cinemeta, torrentio]);
  mocks.chosen.mockResolvedValue(null);
  mocks.device.mockResolvedValue(device);
  mocks.profileSettings.mockResolvedValue(profileSettings);
  mocks.titleProgress.mockResolvedValue([]);
  mocks.add.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  mocks.remove.mockResolvedValue(undefined);
  mocks.openTray.mockClear();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloading from the title page", () => {
  it("adds the best stream that has a link, skipping a torrent-only pick", async () => {
    // The show last played from Peerflix, so its torrent is the top pick; it
    // can't be downloaded, and the best linked stream goes instead.
    mocks.addons.mockResolvedValue([cinemeta, torrentio, peerflix]);
    mocks.visible.mockResolvedValue([cinemeta, torrentio, peerflix]);
    mocks.chosen.mockResolvedValue({
      source: peerflix.url,
      resolution: "1080p",
      group: "",
      chosenAt: 1,
    });
    serve({
      [movieStreams("peerflix.example")]: { streams: [p2p] },
      [movieStreams("torrentio.strem.fun")]: { streams: [linked] },
    });

    const user = userEvent.setup();
    await renderApp(moviePath);
    await user.click(await screen.findByRole("button", { name: "Download" }));

    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [request] = mocks.add.mock.calls[0]!;
    expect(request.request.url).toBe(linked.url);
    expect(request).toMatchObject({
      profileId: 1,
      contentId: "tt0111161",
      contentType: "movie",
      videoId: "tt0111161",
      season: 0,
      episode: 0,
      name: "The Shawshank Redemption",
      metaAddon: cinemeta.url,
      streamSource: torrentio.url,
      resolution: "1080p",
    });
  });

  it("says there is nothing to download when every stream is a torrent", async () => {
    mocks.visible.mockResolvedValue([cinemeta, peerflix]);
    mocks.addons.mockResolvedValue([cinemeta, peerflix]);
    serve({ [movieStreams("peerflix.example")]: { streams: [p2p] } });

    const user = userEvent.setup();
    await renderApp(moviePath);
    await user.click(await screen.findByRole("button", { name: "Download" }));

    expect(
      await screen.findByText("No stream to download. Pick one in the stream list.", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("shows a download's status, and removes it after a yes", async () => {
    mocks.list.mockResolvedValue([record()]);

    const user = userEvent.setup();
    await renderApp(moviePath);
    // Not "Download": the record says where it is.
    await user.click(await screen.findByRole("button", { name: "Downloaded" }));
    expect(await screen.findByText("Remove the download?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(1, [record().id]));
  });
});

describe("downloading a season", () => {
  it("queues the aired episodes that aren't downloaded yet, in order", async () => {
    serve({
      [seriesStreams("torrentio.strem.fun", "tt0903747:1:1")]: {
        streams: [debrid(episodeFile(1, 1))],
      },
      [seriesStreams("torrentio.strem.fun", "tt0903747:1:3")]: {
        streams: [debrid(episodeFile(1, 3))],
      },
      [seriesStreams("torrentio.strem.fun", "tt0903747:1:4")]: {
        streams: [debrid(episodeFile(1, 4))],
      },
    });
    // The second episode is already downloaded: the season leaves it alone.
    mocks.list.mockResolvedValue([episodeRecord(1, 2)]);

    const user = userEvent.setup();
    await renderApp(seriesPath);
    await user.click(await screen.findByRole("button", { name: "Download season" }));

    expect(await screen.findByText("Downloading 3 episodes")).toBeInTheDocument();
    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(3), { timeout: 10_000 });
    expect(mocks.add.mock.calls.map(([request]) => request.videoId)).toEqual([
      "tt0903747:1:1",
      "tt0903747:1:3",
      "tt0903747:1:4",
    ]);
    expect(mocks.add.mock.calls.map(([request]) => request.season)).toEqual([1, 1, 1]);
  });
});

describe("downloading from the picker", () => {
  it("adds the stream a row's menu offers", async () => {
    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0), { timeout: 5000 });

    fireEvent.contextMenu(topPick());
    await user.click(
      await screen.findByRole("menuitem", { name: "Download this stream" }, { timeout: 5000 }),
    );

    await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [request] = mocks.add.mock.calls[0]!;
    expect(request.request.url).toBe(linked.url);
    expect(request).toMatchObject({ contentId: "tt0111161", videoId: "tt0111161" });
  });
});

// A row's menu tells the truth about its download (#85 follow-up): a record
// is only "Downloaded" once Go says the file is here.
describe("a stream row's download menu", () => {
  // The row's own record, running: 40 of 100 bytes.
  const running = record({ state: "downloading", bytes: 40, total: 100, doneAt: 0 });

  it("says a running download is downloading, not downloaded", async () => {
    mocks.list.mockResolvedValue([running]);

    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0), { timeout: 5000 });

    fireEvent.contextMenu(topPick());
    expect(
      await screen.findByRole("menuitem", { name: "Downloading · 40 %" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Downloaded" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Show downloads" }));
    expect(mocks.openTray).toHaveBeenCalledTimes(1);
  });

  it("cancels a running download", async () => {
    mocks.list.mockResolvedValue([running]);

    const user = userEvent.setup();
    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0), { timeout: 5000 });

    fireEvent.contextMenu(topPick());
    await user.click(
      await screen.findByRole("menuitem", { name: "Cancel download" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(1, [running.id]));
  });

  it("offers a finished download, and plays its own copy", async () => {
    mocks.list.mockResolvedValue([record({ state: "done" })]);

    await renderApp(pickerPath);
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0), { timeout: 5000 });

    fireEvent.contextMenu(topPick());
    expect(
      await screen.findByRole("menuitem", { name: "Downloaded" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Play downloaded copy" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Download this stream" }),
    ).not.toBeInTheDocument();
  });
});
