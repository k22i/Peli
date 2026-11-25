import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import type * as Runtime from "@wailsio/runtime";
import { Service as Downloads, type Playable } from "@bindings/downloads";
import type { Ended, State } from "@bindings/player";
import type { Track, Watching } from "@bindings/playback";
import type { Segment, Title } from "@bindings/markers";
import type {
  Addon,
  Download,
  DeviceSettings,
  LibraryItem,
  Profile,
  ProfileSettings,
} from "@bindings/store";
import type { Request, Source } from "@bindings/streams";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import { offlineMessage } from "@/lib/playback";
import { idleState } from "@/lib/player";
import { defaultQuality } from "@/lib/quality";
import { defaultAudio } from "@/lib/sound";
import { profileSettings } from "@/test/fixtures";
import { renderApp } from "@/test/render-app";

// Offline playback (#85, ADR-0064 decision 4): a finished download plays
// before anything is resolved, in the player, with its saved subtitles and
// skip times, in the switcher and as the next episode. Offline, a title with
// no download says so instead of opening a picker that would fail.

configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { data: unknown }) => void>>(),
  // What Go says about Nuvio: "online" or "offline".
  connection: { value: "online" },
  snapshot: vi.fn<() => Promise<State>>(),
  load: vi.fn<(source: Source, opts: { start: number }) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  addSubtitle: vi.fn<(sub: { url: string; lang: string; title: string }) => Promise<number>>(),
  resolve: vi.fn<(request: Request) => Promise<Source>>(),
  release: vi.fn<() => Promise<void>>(),
  segments: vi.fn<(title: Title) => Promise<Segment[]>>(),
  settings: vi.fn<() => Promise<ProfileSettings>>(),
  deviceSettings: vi.fn<() => Promise<DeviceSettings>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        const listeners = mocks.handlers.get(name) ?? new Set();
        listeners.add(callback);
        mocks.handlers.set(name, listeners);
        return () => listeners.delete(callback);
      },
    },
  };
});

vi.mock("@bindings/player", () => ({
  Service: {
    Snapshot: mocks.snapshot,
    Load: mocks.load,
    Stop: mocks.stop,
    AddSubtitle: mocks.addSubtitle,
    SubtitleSync: () => Promise.resolve({ status: "", firstShift: 0, lastShift: 0 }),
    SystemCaptions: () => Promise.resolve(false),
    SetPaused: () => Promise.resolve(),
    Seek: () => Promise.resolve(),
    Scrub: () => Promise.resolve(),
    SetVolume: () => Promise.resolve(),
    SetMuted: () => Promise.resolve(),
    SetFullscreen: () => Promise.resolve(),
    SetMini: () => Promise.resolve(),
    SetVideoInset: () => Promise.resolve(),
    SetNowPlaying: () => Promise.resolve(),
    SetAudioTrack: () => Promise.resolve(),
    SetSubtitleTrack: () => Promise.resolve(),
    SetSubtitleDelay: () => Promise.resolve(),
    SetSubtitleSize: () => Promise.resolve(),
    SetSubtitleStyle: () => Promise.resolve(),
    SetSecondarySubtitleTrack: () => Promise.resolve(),
    SetPanscan: () => Promise.resolve(),
    SetPicture: () => Promise.resolve(),
    SetFraming: () => Promise.resolve(),
    SetQuality: () => Promise.resolve(),
    SetSound: () => Promise.resolve(),
    SetAudio: () => Promise.resolve(),
    SetAudioDelay: () => Promise.resolve(),
    SetSpeed: () => Promise.resolve(),
    SetLoop: () => Promise.resolve(),
    FrameStep: () => Promise.resolve(),
    Screenshot: () => Promise.resolve(),
    ShowScreenshot: () => Promise.resolve(),
    AudioDevices: () => Promise.resolve([]),
    Stats: () => Promise.resolve(null),
    Brightness: () => Promise.resolve(0.5),
    SetBrightness: () => Promise.resolve(),
    SystemVolume: () => Promise.resolve(0.5),
    SetSystemVolume: () => Promise.resolve(),
  },
}));

vi.mock("@bindings/streams", () => ({
  Service: {
    Resolve: (request: Request) => Object.assign(mocks.resolve(request), { cancel: () => {} }),
  },
}));
vi.mock("@bindings/torrent", () => ({
  Service: {
    Status: () => Promise.resolve({ active: false }),
    Release: mocks.release,
    Open: () => Object.assign(Promise.reject(new Error("no torrents")), { cancel: () => {} }),
  },
}));
vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => Promise.resolve([]),
    Refresh: () => Promise.resolve(0),
    Streams: () => Promise.resolve([]),
  },
}));
vi.mock("@bindings/markers", () => ({ Service: { Segments: mocks.segments } }));
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));
vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));
vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: () => Promise.resolve(mocks.connection.value),
    CheckConnection: () => Promise.resolve(mocks.connection.value),
  },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;
const heat: LibraryItem = {
  contentId: "tt0111161",
  contentType: "movie",
  name: "The Shawshank Redemption",
  releaseInfo: "1994",
  addedAt: 1000,
};
const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    ProfileSettings: mocks.settings,
    SaveProfileSettings: () => Promise.resolve(),
    DeviceSettings: mocks.deviceSettings,
    Addons: mocks.addons,
    VisibleAddons: mocks.addons,
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    Library: () => Promise.resolve([heat]),
    LastWatched: () => Promise.resolve({}),
    ContinueWatching: () => Promise.resolve([]),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
    ChosenSource: () => Promise.resolve(null),
    SetChosenSource: () => Promise.resolve(),
    TitleAdjustments: () => Promise.resolve(null),
    SetTitleAdjustments: () => Promise.resolve(),
    SeedAudioLanguages: () => Promise.resolve(false),
  },
}));

// A file on this device, as Go's Playable describes it.
const dir =
  "/Users/test/Library/Application Support/Peli/Downloads/0123456789abcdef0123456789abcdef";
const localSource: Source = {
  url: `${dir}/video.mkv`,
  origin: "download:0123456789abcdef0123456789abcdef",
  headers: {},
  userAgent: "",
  contentType: "video/x-matroska",
  size: 1,
};
const localSubtitle = `file://${encodeURI(dir)}/subs/0.srt`;

function download(fields: Partial<Download> = {}): Download {
  return {
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
    streamSource: "https://torrentio.strem.fun/manifest.json",
    streamName: "Torrentio",
    streamDescription: "",
    resolution: "1080p",
    request: { url: "https://cdn.example/film.mkv", headers: null },
    root: "",
    file: "0123456789abcdef0123456789abcdef/video.mkv",
    mimeType: "video/x-matroska",
    subtitles: null,
    segments: null,
    state: "done",
    reason: "",
    bytes: 2_000_000_000,
    total: 2_000_000_000,
    createdAt: 1,
    updatedAt: 2,
    doneAt: 3,
    ...fields,
  };
}

function playableOf(fields: Partial<Playable> = {}): Playable {
  return {
    download: download(),
    source: localSource,
    subtitles: [{ url: localSubtitle, lang: "en", title: "English" }],
    segments: [{ kind: "intro", start: 10, end: 60 }],
    ...fields,
  };
}

// A Wails call's promise, as the bindings type it.
function cancellable<T>(value: T) {
  return CancellablePromise.resolve(value);
}

// Answers Downloads.Playable per video id: null for any other.
function downloaded(byVideo: Record<string, Playable>) {
  vi.mocked(Downloads.Playable).mockImplementation((_profileId: number, video: string) =>
    cancellable<Playable | null>(byVideo[video] ?? null),
  );
}

const emit = (name: string, data: unknown) =>
  act(() => {
    for (const listener of mocks.handlers.get(name) ?? []) listener({ data });
  });

const playing: State = { ...idleState, active: true, position: 600, duration: 7200 };
const track = (fields: Partial<Track> & Pick<Track, "id" | "type">): Track => ({
  title: "",
  lang: "",
  codec: "",
  default: false,
  selected: false,
  secondary: false,
  external: false,
  forced: false,
  hearingImpaired: false,
  ...fields,
});
// Japanese audio and no subtitles of its own.
const japaneseOnly: State = {
  ...playing,
  tracks: [track({ id: 1, type: "audio", lang: "jpn", selected: true })],
};

const film: Watching = {
  profileId: 1,
  contentId: "tt0111161",
  contentType: "movie",
  videoId: "tt0111161",
  title: "The Film",
};
const pilot: Watching = {
  profileId: 1,
  contentId: "tt0903747",
  contentType: "series",
  videoId: "tt0903747:1:1",
  season: 1,
  episode: 1,
  title: "Pilot",
};

function serve() {
  const answers: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    "https://v3-cinemeta.strem.io/meta/movie/tt0111161.json": cinemetaMovie,
    "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
  };
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url in answers ? Response.json(answers[url]) : new Response("", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function openPlayer(played: Source, watching: Watching, episode?: string) {
  const app = await renderApp("/library", { shell: false });
  await act(() =>
    app.router.navigate({
      to: "/player",
      state: (state) => ({
        ...state,
        player: { title: "The Film", episode, source: played, watching, resumedAt: 0 },
      }),
    }),
  );
  await screen.findByRole("heading", { name: "The Film" });
  await waitFor(() =>
    expect(app.queryClient.getQueryData(["settings", "profile", 1])).toBeDefined(),
  );
  return app;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.connection.value = "online";
  mocks.snapshot.mockReset().mockResolvedValue({ ...idleState, active: true, loading: true });
  mocks.load.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.addSubtitle.mockReset().mockResolvedValue(10);
  mocks.resolve.mockReset().mockRejectedValue(new Error("nothing is resolved for a download"));
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.segments.mockReset().mockResolvedValue([]);
  mocks.addons.mockReset().mockResolvedValue([cinemeta]);
  mocks.settings
    .mockReset()
    .mockResolvedValue(
      profileSettings({ audioLanguages: ["ja"], subtitleLanguage: "en", captions: "on" }),
    );
  mocks.deviceSettings.mockReset().mockResolvedValue({
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
    seekPreviews: true,
    previewsFromSmaller: false,
    streamSort: "best",
    partyDock: false,
    downloadsDir: "",
    downloadsCapGB: 50,
    downloadsWiFiOnly: true,
    skipProfilePicker: false,
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
  });
  vi.mocked(Downloads.Playable).mockReset();
  downloaded({});
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const playFromHome = async () => {
  const app = await renderApp("/");
  const region = await screen.findByRole("region", { name: "Your library" });
  fireEvent.contextMenu(await within(region).findByRole("button", { name: /Shawshank/ }));
  await userEvent.setup().click(await screen.findByRole("menuitem", { name: "Play" }));
  return app;
};

const openSwitcher = async () => {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Streams" }));
  return screen.findByRole("dialog", { name: "Streams" });
};

const card = () => screen.findByRole("region", { name: "Next episode" });

describe("Play with a download", () => {
  it("goes straight to the player with the local file, resolving nothing", async () => {
    downloaded({ tt0111161: playableOf() });
    const { router } = await playFromHome();

    await waitFor(() => expect(router.state.location.pathname).toBe("/player"));
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      localSource,
      expect.objectContaining({
        start: 0,
        watching: expect.objectContaining({
          profileId: 1,
          contentId: "tt0111161",
          contentType: "movie",
          videoId: "tt0111161",
        }),
      }),
    );
    expect(router.state.location.state.player?.source).toEqual(localSource);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("says so, and stays put, offline with nothing downloaded", async () => {
    mocks.connection.value = "offline";
    const { router } = await renderApp("/");
    await waitFor(() => expect(document.body).toHaveTextContent(/offline/i));
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Shawshank/ }));
    await userEvent.setup().click(await screen.findByRole("menuitem", { name: "Play" }));

    expect(await screen.findByText(offlineMessage)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("opens the picker as before when online with nothing downloaded", async () => {
    const { router } = await playFromHome();
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/movie/tt0111161"));
    expect(screen.queryByText(offlineMessage)).not.toBeInTheDocument();
  });
});

describe("the player with a download", () => {
  it("adds the saved subtitles from disk, and asks no one for more", async () => {
    downloaded({ tt0111161: playableOf() });
    const fetch = serve();
    await openPlayer(localSource, film);
    emit("player:state", japaneseOnly);

    await waitFor(() =>
      expect(mocks.addSubtitle).toHaveBeenCalledExactlyOnceWith({
        url: localSubtitle,
        lang: "en",
        title: "Downloaded",
        secondary: false,
        autoSync: true,
      }),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    // No subtitle addon is asked: nothing is fetched for them.
    expect(fetch.mock.calls.filter(([url]) => url.includes("/subtitles/"))).toHaveLength(0);
  });

  it("skips with the saved times and doesn't ask IntroDB", async () => {
    downloaded({ tt0111161: playableOf({ subtitles: null }) });
    await openPlayer(localSource, film);
    emit("player:state", { ...japaneseOnly, position: 20 });

    expect(await screen.findByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    expect(mocks.segments).not.toHaveBeenCalled();
  });

  it("doesn't ask for the file again when it fails", async () => {
    downloaded({ tt0111161: playableOf() });
    await openPlayer(localSource, film);
    emit("player:state", japaneseOnly);
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

describe("the stream switcher with a download", () => {
  it("lists the local copy first, marked Playing when it is", async () => {
    downloaded({ tt0111161: playableOf() });
    await openPlayer(localSource, film);
    emit("player:state", playing);
    const panel = await openSwitcher();

    const row = await within(panel).findByRole("button", { name: /Downloaded/ });
    expect(row).toHaveTextContent("1080p");
    expect(row).toHaveTextContent("Playing");
  });

  it("offline, lists only the local copy and says the rest need a connection", async () => {
    mocks.connection.value = "offline";
    downloaded({ tt0111161: playableOf() });
    // Streaming from a link that can't be reached now: the copy isn't playing.
    await openPlayer({ ...localSource, url: "https://cdn.example/film.mkv", origin: "x" }, film);
    emit("player:state", playing);
    const panel = await openSwitcher();

    const row = await within(panel).findByRole("button", { name: /Downloaded/ });
    expect(row).not.toHaveTextContent("Playing");
    expect(await within(panel).findByText("Other streams need a connection.")).toBeInTheDocument();

    // Picking it plays the file from where this one is.
    mocks.snapshot.mockResolvedValue({ ...playing, position: 321 });
    await userEvent.setup().click(row);
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        localSource,
        expect.objectContaining({
          start: 321,
          watching: expect.objectContaining({ videoId: film.videoId }),
        }),
      ),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

describe("the next episode with a download", () => {
  const before: State = { ...playing, position: 3000, duration: 3480 };
  const watched: State = { ...playing, position: 3200, duration: 3480 };
  const nextSource: Source = {
    ...localSource,
    url: `${dir}/next.mkv`,
    origin: "download:fedcba9876543210fedcba9876543210",
  };
  const second = () =>
    playableOf({
      download: download({
        id: "fedcba9876543210fedcba9876543210",
        contentId: "tt0903747",
        contentType: "series",
        videoId: "tt0903747:1:2",
        season: 1,
        episode: 2,
        name: "Breaking Bad",
        episodeName: "Cat's in the Bag...",
      }),
      source: nextSource,
      subtitles: null,
      segments: null,
    });

  it("prefers it, ready at once, and plays it at the end", async () => {
    downloaded({ "tt0903747:1:2": second() });
    const { router } = await openPlayer(localSource, pilot, "S1 · E1 · Pilot");
    emit("player:state", before);
    await screen.findByRole("button", { name: "Pause" });
    emit("player:state", watched);

    const next = await card();
    expect(next).toHaveTextContent("S1 · E2 · Cat's in the Bag...");
    expect(await within(next).findByText("Downloaded")).toBeInTheDocument();

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        nextSource,
        expect.objectContaining({
          start: 0,
          watching: expect.objectContaining({
            contentId: "tt0903747",
            videoId: "tt0903747:1:2",
            season: 1,
            episode: 2,
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(router.state.location.state.player?.watching?.videoId).toBe("tt0903747:1:2"),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("offers nothing offline when the next episode isn't downloaded", async () => {
    mocks.connection.value = "offline";
    await openPlayer(localSource, pilot, "S1 · E1 · Pilot");
    emit("player:state", before);
    await screen.findByRole("button", { name: "Pause" });
    emit("player:state", watched);
    await screen.findByRole("button", { name: "Pause" });

    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();
    // The file just ends, as it does on Cancel.
    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled());
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
