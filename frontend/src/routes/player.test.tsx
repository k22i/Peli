import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";
import type { Ended, State } from "@bindings/player";
import type { Track, Watching } from "@bindings/playback";
import type { Segment, Title } from "@bindings/markers";
import type {
  Addon,
  ChosenSource,
  DeviceSettings,
  Profile,
  ProfileSettings,
  Progress,
} from "@bindings/store";
import type { Request, Source } from "@bindings/streams";
import type { Request as TorrentRequest, Status } from "@bindings/torrent";
import { defaultQuality } from "@/lib/quality";
import { defaultAudio } from "@/lib/sound";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import opensubtitlesManifest from "@/lib/addon-protocol/fixtures/opensubtitles/manifest.json";
import opensubtitlesMovie from "@/lib/addon-protocol/fixtures/opensubtitles/subtitles-movie.json";
import torrentioManifest from "@/lib/addon-protocol/fixtures/torrentio/manifest.json";
import type { Stream } from "@/lib/addon-protocol";
import { Party } from "@/lib/party";
import { idleState } from "@/lib/player";
import type { SubtitleTarget } from "@/lib/subtitles";
import { partyMember, partyState, profileSettings } from "@/test/fixtures";
import { onCompactIOS, onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// The player is several queries deep (profile, settings, addons, their
// answers) and loads a lot of code on the first test, so a loaded machine
// needs more than the defaults.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

const mocks = vi.hoisted(() => ({
  // Every listener of each event, as the runtime keeps them.
  handlers: new Map<string, Set<(event: { data: unknown }) => void>>(),
  snapshot: vi.fn<() => Promise<State>>(),
  load: vi.fn<(source: Source, opts: { start: number }) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  setPaused: vi.fn<(paused: boolean) => Promise<void>>(),
  seek: vi.fn<(position: number) => Promise<void>>(),
  scrub: vi.fn<(position: number) => Promise<void>>(),
  setVolume: vi.fn<(volume: number) => Promise<void>>(),
  setMuted: vi.fn<(muted: boolean) => Promise<void>>(),
  setFullscreen: vi.fn<(on: boolean) => Promise<void>>(),
  setMini: vi.fn<(on: boolean) => Promise<void>>(),
  setVideoInset: vi.fn<(rightPx: number) => Promise<void>>(),
  // What usePartyDock says: the party panel as a sidebar, or a sheet.
  dock: { docked: false },
  setNowPlaying: vi.fn<(np: { title: string; subtitle: string }) => Promise<void>>(),
  setAudioTrack: vi.fn<(id: number) => Promise<void>>(),
  setSubtitleTrack: vi.fn<(id: number) => Promise<void>>(),
  setSubtitleDelay: vi.fn<(delay: number) => Promise<void>>(),
  setSubtitleSize: vi.fn<(size: string) => Promise<void>>(),
  addSubtitle: vi.fn<(sub: { url: string; lang: string; title: string }) => Promise<number>>(),
  systemCaptions: vi.fn<() => Promise<boolean>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[]>>(),
  titleProgress: vi.fn<(profileId: number, contentId: string) => Promise<Progress[]>>(),
  settings: vi.fn<() => Promise<ProfileSettings>>(),
  deviceSettings: vi.fn<() => Promise<DeviceSettings>>(),
  segments: vi.fn<(title: Title) => Promise<Segment[]>>(),
  saveSettings: vi.fn<(id: number, settings: ProfileSettings) => Promise<void>>(),
  resolve: vi.fn<(request: Request) => Promise<Source>>(),
  torrentStatus: vi.fn<() => Promise<Status>>(),
  release: vi.fn<() => Promise<void>>(),
  openTorrent: vi.fn<(request: TorrentRequest) => Promise<Source>>(),
  chosen: vi.fn<(profileId: number, contentId: string) => Promise<ChosenSource | null>>(),
  setChosen:
    vi.fn<(profileId: number, contentId: string, chosen: ChosenSource | null) => Promise<void>>(),
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

// The dock is another file's (components/party/party-dock): here it is a
// stand-in with a chat field and a close button, docked as `mocks.dock` says.
vi.mock("@/components/party/party-dock", () => ({
  partyDockWidth: "22rem",
  usePartyDock: () => ({ docked: mocks.dock.docked, setDocked: () => {}, available: true }),
  PartyDock: ({ onClose }: { onClose: () => void }) => (
    <aside aria-label="Party dock">
      <input aria-label="Chat message" />
      <button onClick={onClose}>Close dock</button>
    </aside>
  ),
}));

vi.mock("@bindings/player", () => ({
  Service: {
    Snapshot: mocks.snapshot,
    Load: mocks.load,
    Stop: mocks.stop,
    SetPaused: mocks.setPaused,
    Seek: mocks.seek,
    Scrub: mocks.scrub,
    SetVolume: mocks.setVolume,
    SetMuted: mocks.setMuted,
    SetFullscreen: mocks.setFullscreen,
    SetMini: mocks.setMini,
    SetVideoInset: mocks.setVideoInset,
    SetNowPlaying: mocks.setNowPlaying,
    SetAudioTrack: mocks.setAudioTrack,
    SetSubtitleTrack: mocks.setSubtitleTrack,
    SetSubtitleDelay: mocks.setSubtitleDelay,
    SetSubtitleSize: mocks.setSubtitleSize,
    SetSubtitleStyle: () => Promise.resolve(),
    SetSecondarySubtitleTrack: () => Promise.resolve(),
    AddSubtitle: mocks.addSubtitle,
    SystemCaptions: mocks.systemCaptions,
    // The touch chrome reads the screen's brightness and the system volume (#131).
    Brightness: () => Promise.resolve(0.5),
    SetBrightness: () => Promise.resolve(),
    SystemVolume: () => Promise.resolve(0.5),
    SetSystemVolume: () => Promise.resolve(),
    // The touch layout's effects reach the picture, sound and playback ones too.
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
  },
}));

// Wails calls: promises with cancel.
vi.mock("@bindings/streams", () => ({
  Service: {
    Resolve: (request: Request) => Object.assign(mocks.resolve(request), { cancel: () => {} }),
  },
}));
vi.mock("@bindings/torrent", () => ({
  Service: {
    Status: mocks.torrentStatus,
    Release: mocks.release,
    Open: (request: TorrentRequest) =>
      Object.assign(mocks.openTorrent(request), { cancel: () => {} }),
  },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    ProfileSettings: mocks.settings,
    SaveProfileSettings: mocks.saveSettings,
    DeviceSettings: mocks.deviceSettings,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    TitleProgress: mocks.titleProgress,
    ChosenSource: mocks.chosen,
    SetChosenSource: mocks.setChosen,
    TitleAdjustments: () => Promise.resolve(null),
    SetTitleAdjustments: () => Promise.resolve(),
    // iOS only: seeds the profile's audio languages from the device's.
    SeedAudioLanguages: () => Promise.resolve(false),
  },
}));

// Japanese audio with English captions, large.
const japaneseTracks = {
  audioLanguages: ["ja"],
  subtitleLanguage: "en",
  subtitleSize: "large",
  captions: "on",
};
const japanese = profileSettings(japaneseTracks);
// What Player.Load gets from it: the style goes too (#63).
const profileOptions = { ...japaneseTracks, subtitleStyle: japanese.subtitleStyle, start: 600 };

// IntroDB, through Go (#69).
// Plugins (#56): none installed.
vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => Promise.resolve([]),
    Refresh: () => Promise.resolve(0),
    Streams: () => Promise.resolve([]),
  },
}));

vi.mock("@bindings/markers", () => ({ Service: { Segments: mocks.segments } }));

// No TMDB key (#99): ranking asks for the title's other names only with one.
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

const source: Source = {
  url: "https://cdn.example/KEY/film.mkv",
  origin: "https://torrentio.strem.fun/resolve/torbox/KEY/abc/null/0/film.mkv",
  headers: { Referer: "https://addon.example/" },
  userAgent: "Peli/test",
  contentType: "video/x-matroska",
  size: 1,
};

const emit = (name: string, data: unknown) =>
  act(() => {
    for (const listener of mocks.handlers.get(name) ?? []) listener({ data });
  });

const playing: State = { ...idleState, active: true, position: 600, duration: 7200 };

// A torrent streamed through internal/torrent's loopback server (#55).
const torrent: Source = {
  url: "http://127.0.0.1:50123/secret/abc/0/film.mkv",
  origin: "magnet:?xt=urn:btih:abc",
  headers: {},
  userAgent: "",
  contentType: "video/x-matroska",
  size: 1,
};

async function openPlayer(
  episode?: string,
  played = source,
  subtitles?: SubtitleTarget,
  progress: { watching?: Watching; resumedAt?: number; stream?: Stream } = {},
) {
  const app = await renderApp("/library", { shell: false });
  await act(() =>
    app.router.navigate({
      to: "/player",
      state: (state) => ({
        ...state,
        player: {
          title: "The Film",
          episode,
          source: played,
          ...(subtitles && { subtitles }),
          ...progress,
        },
      }),
    }),
  );
  await screen.findByRole("heading", { name: "The Film" });
  // The profile's settings arrive after the page does; what a test does next
  // (a retry, an ended file) should see them.
  await waitFor(() =>
    expect(app.queryClient.getQueryData(["settings", "profile", 1])).toBeDefined(),
  );
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  mocks.handlers.clear();
  mocks.dock.docked = false;
  mocks.chosen.mockReset().mockResolvedValue(null);
  mocks.setChosen.mockReset().mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue({ ...idleState, active: true, loading: true });
  mocks.load.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.setPaused.mockResolvedValue(undefined);
  for (const call of [
    mocks.seek,
    mocks.scrub,
    mocks.setVolume,
    mocks.setMuted,
    mocks.setFullscreen,
    mocks.setMini,
    mocks.setVideoInset,
    mocks.setNowPlaying,
    mocks.setAudioTrack,
    mocks.setSubtitleTrack,
    mocks.setSubtitleDelay,
    mocks.setSubtitleSize,
    mocks.saveSettings,
  ]) {
    call.mockReset().mockResolvedValue(undefined);
  }
  mocks.addSubtitle.mockReset().mockResolvedValue(10);
  mocks.systemCaptions.mockReset().mockResolvedValue(false);
  mocks.addons.mockReset().mockResolvedValue([]);
  mocks.visibleAddons.mockReset().mockResolvedValue([]);
  mocks.titleProgress.mockReset().mockResolvedValue([]);
  mocks.openTorrent.mockReset();
  mocks.settings.mockReset().mockResolvedValue(japanese);
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
    streamSort: "best",
    partyDock: false,
    downloadsDir: "",
    downloadsCapGB: 50,
    downloadsWiFiOnly: true,
    quality: defaultQuality,
    audio: defaultAudio,
  });
  mocks.segments.mockReset().mockResolvedValue([]);
  mocks.resolve.mockResolvedValue({ ...source, url: "https://cdn.example/KEY/fresh.mkv" });
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.torrentStatus.mockReset().mockResolvedValue({
    active: true,
    ready: true,
    peers: 12,
    seeders: 4,
    downloadRate: 3_400_000,
    uploadRate: 200_000,
    ahead: 48_000_000,
    done: 120_000_000,
    size: 2_100_000_000,
  });
});

describe("player", () => {
  it("shows the video with no shell, and a spinner until the first frame", async () => {
    await openPlayer();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Loading" })).toBeInTheDocument();

    emit("player:state", playing);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("pauses on a click or Space", async () => {
    await openPlayer();
    emit("player:state", playing);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Pause" }));
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...playing, paused: true });
    await user.keyboard(" ");
    expect(mocks.setPaused).toHaveBeenLastCalledWith(false);
  });

  it("stops and goes back on Back, and at the end", async () => {
    const { router } = await openPlayer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());

    await act(() =>
      router.navigate({ to: "/player", state: (s) => ({ ...s, player: { title: "The Film" } }) }),
    );
    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(2));
  });

  it("asks for an expired link again and plays on from where it stopped", async () => {
    await openPlayer();
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);

    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://cdn.example/KEY/fresh.mkv" }),
        profileOptions,
      ),
    );
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      url: source.origin,
      headers: source.headers,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Again within the minute: no loop of asking.
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);
    expect(await screen.findByRole("alert")).toHaveTextContent("The link expired");
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it("shows a torrent's peers, speed and buffer, and lets it go on leaving", async () => {
    const { router } = await openPlayer(undefined, torrent);
    expect(await screen.findByLabelText("Torrent status")).toHaveTextContent(
      "12 peers · 3.4 MB/s · 48 MB ready",
    );
    // Under the spinner too, while it waits for pieces.
    expect(screen.getAllByText("12 peers · 3.4 MB/s · 48 MB ready")).toHaveLength(2);

    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0]!,
    );
  });

  it("doesn't ask an addon again for a torrent's link", async () => {
    await openPlayer(undefined, torrent);
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);
    expect(await screen.findByRole("alert")).toHaveTextContent("The stream stopped");
    expect(mocks.resolve).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(torrent, profileOptions));
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("doesn't ask about torrents for other streams", async () => {
    const { router } = await openPlayer();
    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    expect(mocks.torrentStatus).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("says why a stream stopped", async () => {
    await openPlayer();
    emit("player:ended", { reason: "error", code: "unsupported" } satisfies Ended);
    expect(await screen.findByRole("alert")).toHaveTextContent("Peli can’t play this file");
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("shows the title, the episode and the time", async () => {
    await openPlayer("S1 · E2 · Cat’s in the Bag");
    expect(screen.getByText("S1 · E2 · Cat’s in the Bag")).toBeInTheDocument();
    emit("player:state", playing);
    // The time played at the bar's start, what's left at its end.
    expect(await screen.findByTestId("elapsed")).toHaveTextContent("10:00");
    expect(screen.getByTestId("remaining")).toHaveTextContent("-1:50:00");
    emit("player:time", { position: 601, duration: 7200, buffered: 30 });
    await waitFor(() => expect(screen.getByTestId("elapsed")).toHaveTextContent("10:01"));
    expect(screen.getByTestId("remaining")).toHaveTextContent("-1:49:59");
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
      "aria-valuetext",
      "10:01 of 2:00:00",
    );
  });

  it("skips 10 seconds at once, before the player catches up", async () => {
    await openPlayer();
    emit("player:state", playing);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Forward 10 seconds" }));
    expect(mocks.seek).toHaveBeenLastCalledWith(610);
    expect(screen.getByTestId("elapsed")).toHaveTextContent("10:10");
    // A time event from before the seek doesn't take it back.
    emit("player:time", { position: 600.2, duration: 7200, buffered: 0 });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("10:10");
    // Twice quickly: from where the first one went.
    await user.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(620));

    emit("player:state", { ...playing, position: 620 });
    emit("player:state", { ...playing, position: 4 });
    await user.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(0));
  });

  it("seeks from the seek bar, and shows the time under the pointer", async () => {
    await openPlayer();
    emit("player:state", playing);
    const slider = await screen.findByRole("slider", { name: "Seek" });
    act(() => slider.focus());
    const user = userEvent.setup();
    await user.keyboard("{PageUp}");
    expect(mocks.seek).toHaveBeenLastCalledWith(610);
    expect(mocks.scrub).not.toHaveBeenCalled();

    const bar = screen.getByTestId("seek-bar");
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 20 }),
    );
    fireEvent.pointerMove(bar, { clientX: 500 });
    expect(within(bar).getByText("1:00:00")).toBeInTheDocument();
    fireEvent.pointerLeave(bar);
    expect(within(bar).queryByText("1:00:00")).not.toBeInTheDocument();
  });

  it("shows what's buffered ahead", async () => {
    await openPlayer();
    emit("player:state", { ...playing, position: 720, buffered: 360 });
    const buffered = await screen.findByTestId("buffered");
    expect(buffered.style.left).toBe("10%");
    expect(buffered.style.width).toBe("5%");
  });

  it("mutes, sets the volume and goes fullscreen", async () => {
    await openPlayer();
    emit("player:state", playing);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Mute" }));
    expect(mocks.setMuted).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...playing, muted: true });
    // Muted, the volume reads 0.
    expect(screen.getByRole("slider", { name: "Volume" })).toHaveAttribute("aria-valuenow", "0");
    await user.click(screen.getByRole("button", { name: "Unmute" }));
    expect(mocks.setMuted).toHaveBeenLastCalledWith(false);

    emit("player:state", { ...playing, volume: 50 });
    act(() => screen.getByRole("slider", { name: "Volume" }).focus());
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(mocks.setVolume).toHaveBeenLastCalledWith(49));
    // The slider's arrow, not the player's.
    expect(mocks.seek).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Full screen" }));
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...playing, fullscreen: true });
    // Esc leaves fullscreen first, not the player.
    await user.keyboard("{Escape}");
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();
  });

  it("makes the window the mini player and back", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Mini player" }));
    expect(mocks.setMini).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...withTracks, mini: true });
    // Only play, mute and the seek bar fit.
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    for (const name of ["Subtitles", "Audio", "Full screen", "Keyboard shortcuts"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    // No room for the shortcuts.
    await user.keyboard("?");
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

    // Esc leaves the mini player, not the player.
    await user.keyboard("{Escape}");
    expect(mocks.setMini).toHaveBeenLastCalledWith(false);
    emit("player:state", withTracks);
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();

    await user.keyboard("i");
    expect(mocks.setMini).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...withTracks, mini: true });
    await user.click(screen.getByRole("button", { name: "Exit mini player" }));
    expect(mocks.setMini).toHaveBeenLastCalledWith(false);
  });

  it("keeps the volume slider in the bar, and the mini player's time as it was", async () => {
    await openPlayer();
    emit("player:state", playing);
    // In the bar, with no hover to reveal it.
    expect(await screen.findByRole("slider", { name: "Volume" })).toBeInTheDocument();
    expect(screen.getByTestId("elapsed")).toBeInTheDocument();

    emit("player:state", { ...playing, mini: true });
    // The mini player has no room for the two times: one reads "pos / duration".
    expect(await screen.findByText("10:00 / 2:00:00")).toBeInTheDocument();
    expect(screen.queryByTestId("elapsed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remaining")).not.toBeInTheDocument();
  });

  it("marks a click or Space on the video at the centre, for a moment", async () => {
    await openPlayer();
    emit("player:state", playing);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByTestId("playback-flash")).not.toBeInTheDocument();

    // The video is the button behind the controls.
    await user.click(screen.getByTestId("controls").previousElementSibling!);
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    // It's for the eye: the Play button's label already says it.
    expect(screen.getByTestId("playback-flash")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("playback-flash")).not.toBeInTheDocument(), {
      timeout: 2000,
    });

    await user.keyboard(" ");
    expect(mocks.setPaused).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("playback-flash")).toBeInTheDocument();
  });

  it("Space on a focused button only pauses", async () => {
    await openPlayer();
    emit("player:state", playing);
    act(() => screen.getByRole("button", { name: "Forward 10 seconds" }).focus());
    const user = userEvent.setup();
    await user.keyboard(" ");
    expect(mocks.setPaused).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("hides the controls and the cursor while playing and still", async () => {
    await openPlayer();
    emit("player:state", playing);
    vi.useFakeTimers();
    const screenRoot = screen.getByTestId("controls").parentElement!;
    fireEvent.pointerMove(screenRoot);
    expect(screen.getByTestId("controls")).toHaveAttribute("data-shown");

    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("controls")).not.toHaveAttribute("data-shown");
    expect(screenRoot).toHaveClass("cursor-none");

    fireEvent.pointerMove(screenRoot);
    expect(screen.getByTestId("controls")).toHaveAttribute("data-shown");
    // Paused, they stay.
    emit("player:state", { ...playing, paused: true });
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("controls")).toHaveAttribute("data-shown");
  });

  it("shows how full the buffer is while it waits", async () => {
    await openPlayer();
    emit("player:state", { ...playing, buffering: true, bufferPercent: 45 });
    expect(await screen.findByText("Buffering 45 %")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("tries a stopped stream again from where it stopped", async () => {
    await openPlayer();
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "failed" } satisfies Ended);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(source, profileOptions);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps the progress of what it plays across a retry, and refreshes it on leaving", async () => {
    const watching: Watching = {
      profileId: 1,
      contentId: "tt0111161",
      contentType: "movie",
      videoId: "tt0111161",
      title: "The Film",
    };
    const { queryClient, router } = await openPlayer(undefined, source, undefined, { watching });
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "failed" } satisfies Ended);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(source, { ...profileOptions, watching });

    // Go kept where it stopped by the time Stop returns: the screens behind
    // show it.
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["continue-watching"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["watched"] });
  });

  it("offers to start over a file that resumed", async () => {
    await openPlayer(undefined, source, undefined, { resumedAt: 600 });
    // Not before it plays.
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
    emit("player:state", playing);
    expect(screen.getByText(/^Resumed at/)).toHaveTextContent("Resumed at 10:00");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(0);
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });

  it("stops offering to start over after a few seconds of playing", async () => {
    await openPlayer(undefined, source, undefined, { resumedAt: 600 });
    vi.useFakeTimers();
    emit("player:state", playing);
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(9000));
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });

  it("asks for an expired link again when told to, even within the minute", async () => {
    await openPlayer();
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
    emit("player:ended", { reason: "error", code: "expired" } satisfies Ended);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("goes back to choose another stream", async () => {
    const { router } = await openPlayer();
    emit("player:ended", { reason: "error", code: "unsupported" } satisfies Ended);
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(alert).getByRole("button", { name: "Choose another stream" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
  });

  it("picks audio and subtitles in the panel", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Audio" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    expect(within(panel).getByRole("tab", { name: "Audio" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(panel).getByRole("button", { name: /^English.*AAC.*Stereo/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(panel).getByRole("button", { name: /^Japanese.*Commentary.*AC3/ }));
    expect(mocks.setAudioTrack).toHaveBeenLastCalledWith(2);
    // Shown at once, before the player says so.
    expect(within(panel).getByRole("button", { name: /^Japanese/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();

    // The Subtitles button opens the same panel at its subtitles.
    await user.click(screen.getByRole("button", { name: "Subtitles" }));
    const subtitles = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    expect(within(subtitles).getByRole("button", { name: /^Off/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(subtitles).getByRole("button", { name: /^English.*Forced/ })).toBeInTheDocument();
    await user.click(within(subtitles).getByRole("button", { name: /^English.*SDH/ }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(4);
    await user.click(within(subtitles).getByRole("button", { name: /^Off/ }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(0);
  });

  it("has no audio menu for one track, nor a subtitles menu for none", async () => {
    await openPlayer();
    emit("player:state", { ...playing, tracks: [english] });
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
  });

  it("sizes subtitles in the panel's Style tab and keeps the size as the profile's", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    await user.click(within(panel).getByRole("tab", { name: "Style" }));
    // Not saved until asked: the size lasts until the video ends.
    expect(within(panel).getByRole("button", { name: "Save as my style" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Larger size" }));
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole("button", { name: "Save as my style" }));
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenLastCalledWith(1, {
        ...japanese,
        subtitleStyle: { ...japanese.subtitleStyle, size: 110 },
      }),
    );
  });

  it("times subtitles with Z and X, and in the panel's Timing tab", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    await screen.findByRole("button", { name: "Subtitles" });
    const user = userEvent.setup();

    await user.keyboard("xxx");
    await waitFor(() => expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(0.3));
    expect(screen.getByText("Subtitles 0.3 s later")).toBeInTheDocument();
    await user.keyboard("zzzz");
    await waitFor(() => expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(-0.1));
    expect(screen.getByText("Subtitles 0.1 s earlier")).toBeInTheDocument();
    // ⌘Z is someone else's.
    await user.keyboard("{Meta>}z{/Meta}");
    expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(-0.1);

    emit("player:state", { ...withTracks, subtitleDelay: -0.1 });
    await user.click(screen.getByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    await user.click(within(panel).getByRole("tab", { name: "Timing" }));
    expect(within(panel).getByText("−0.1 s")).toBeInTheDocument();
    expect(within(panel).getByText("Subtitles show 0.1 s earlier")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "+0.1" }));
    await waitFor(() => expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(0));
    // The panel stays open for more steps.
    expect(within(panel).getByText("0.0 s")).toBeInTheDocument();
    expect(within(panel).getByText("Subtitles show when the file says")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "0" })).toBeDisabled();
  });

  it("names what plays for the OS's media controls", async () => {
    await openPlayer("S1E2 · Cat’s in the Bag…");
    await waitFor(() =>
      expect(mocks.setNowPlaying).toHaveBeenLastCalledWith({
        title: "The Film",
        subtitle: "S1E2 · Cat’s in the Bag…",
      }),
    );
  });

  it("plays, seeks, sets the volume, mutes and goes fullscreen from the keys", async () => {
    await openPlayer();
    emit("player:state", { ...playing, volume: 50 });
    await screen.findByRole("button", { name: "Pause" });
    const user = userEvent.setup();

    await user.keyboard("k");
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(620));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(610));

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(mocks.setVolume).toHaveBeenLastCalledWith(45));
    expect(screen.getByText("Volume 45 %")).toBeInTheDocument();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    await waitFor(() => expect(mocks.setVolume).toHaveBeenLastCalledWith(55));

    await user.keyboard("m");
    expect(mocks.setMuted).toHaveBeenLastCalledWith(true);
    // Muted, up unmutes at the volume it had.
    emit("player:state", { ...playing, volume: 55, muted: true });
    await user.keyboard("{ArrowUp}");
    expect(mocks.setMuted).toHaveBeenLastCalledWith(false);
    expect(mocks.setVolume).toHaveBeenLastCalledWith(55);

    await user.keyboard("f");
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
    // ⌘F and the like are someone else's.
    await user.keyboard("{Meta>}f{/Meta}");
    expect(mocks.setFullscreen).toHaveBeenCalledOnce();
  });

  it("goes round the subtitles with C and the audio with A", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    await screen.findByRole("button", { name: "Subtitles" });
    const user = userEvent.setup();

    await user.keyboard("c");
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(3);
    expect(screen.getByText("Subtitles: English · Signs · Forced")).toBeInTheDocument();
    await user.keyboard("c");
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(4);
    expect(screen.getByText("Subtitles: English · SDH")).toBeInTheDocument();
    await user.keyboard("c");
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("Subtitles off")).toBeInTheDocument();

    await user.keyboard("a");
    expect(mocks.setAudioTrack).toHaveBeenLastCalledWith(2);
    expect(screen.getByText("Audio: Japanese · Commentary · AC3 · 5.1")).toBeInTheDocument();
    await user.keyboard("a");
    expect(mocks.setAudioTrack).toHaveBeenLastCalledWith(1);
  });

  it("does nothing with C and A for a file without tracks to pick", async () => {
    await openPlayer();
    emit("player:state", { ...playing, tracks: [english] });
    await screen.findByRole("button", { name: "Pause" });
    await userEvent.setup().keyboard("ca");
    expect(mocks.setSubtitleTrack).not.toHaveBeenCalled();
    expect(mocks.setAudioTrack).not.toHaveBeenCalled();
  });

  it("lists the shortcuts on ? and from its button", async () => {
    await openPlayer();
    emit("player:state", playing);
    await screen.findByRole("button", { name: "Pause" });
    const user = userEvent.setup();

    await user.keyboard("?");
    const help = screen.getByRole("region", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("Next subtitles, then off")).toBeInTheDocument();
    // The keys still work under it.
    await user.keyboard("k");
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    // Esc closes it, and stays.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    await user.click(
      within(screen.getByRole("region", { name: "Keyboard shortcuts" })).getByRole("button", {
        name: "Close",
      }),
    );
    expect(screen.queryByRole("region", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("tries a stopped stream again with the tracks it was playing", async () => {
    await openPlayer();
    emit("player:state", { ...playing, tracks: tracksSelecting(1, 4) });
    // mpv empties the list when the file fails.
    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "failed" } satisfies Ended);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));

    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(source, {
      ...profileOptions,
      audioLanguages: ["eng"],
      subtitleLanguage: "eng",
      captions: "on",
    });
  });
});

describe("addon subtitles", () => {
  const opensubtitles: Addon = {
    url: "https://opensubtitles-v3.strem.io/manifest.json",
    name: "OpenSubtitles v3",
    enabled: true,
  };
  const asked =
    "https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161/filename=film.mkv.json";
  const target: SubtitleTarget = {
    type: "movie",
    id: "tt0111161",
    extra: { filename: "film.mkv" },
  };
  const firstEnglish = opensubtitlesMovie.subtitles[0]!.url;

  // Serves OpenSubtitles' manifest and its answer for the film.
  function serve(answer: unknown = opensubtitlesMovie) {
    mocks.addons.mockResolvedValue([opensubtitles]);
    const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) => {
      if (url === opensubtitles.url) return Response.json(opensubtitlesManifest);
      if (url === asked) return Response.json(answer);
      return new Response("", { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Japanese audio only: no subtitles of its own.
  const japaneseAudio = [track({ id: 1, type: "audio", lang: "jpn", selected: true })];
  const japaneseOnly: State = { ...playing, tracks: japaneseAudio };

  it("adds the first in the profile's language when the file has none", async () => {
    const fetch = serve();
    await openPlayer(undefined, source, target);
    emit("player:state", japaneseOnly);

    await waitFor(() =>
      expect(mocks.addSubtitle).toHaveBeenCalledExactlyOnceWith({
        url: firstEnglish,
        lang: "en",
        title: "OpenSubtitles v3",
        secondary: false,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(asked, expect.anything());
    // Not saved: nobody picked it.
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("leaves the file's own subtitles in the language alone", async () => {
    serve();
    await openPlayer(undefined, source, target);
    emit("player:state", { ...playing, tracks: tracksSelecting(1, 4) });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    // The addons' answer is in the list, and none was added.
    await within(panel).findByRole("button", { name: /^Brazilian Portuguese/ });
    expect(mocks.addSubtitle).not.toHaveBeenCalled();
  });

  it("follows the OS when captions are System", async () => {
    serve();
    mocks.settings.mockResolvedValue({ ...japanese, captions: "system" });
    await openPlayer(undefined, source, target);
    emit("player:state", japaneseOnly);
    // The panel lists them, but none is added.
    await userEvent.setup().click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    await within(panel).findByRole("button", { name: /^Brazilian Portuguese/ });
    expect(mocks.addSubtitle).not.toHaveBeenCalled();
  });

  it("adds them when the OS asks for captions", async () => {
    serve();
    mocks.settings.mockResolvedValue({ ...japanese, captions: "system" });
    mocks.systemCaptions.mockResolvedValue(true);
    await openPlayer(undefined, source, target);
    emit("player:state", japaneseOnly);
    await waitFor(() => expect(mocks.addSubtitle).toHaveBeenCalledTimes(1));
  });

  it("lists them by language and adds the one picked, keeping its language", async () => {
    serve();
    await openPlayer(undefined, source, target);
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    await within(panel).findByRole("button", { name: /^Brazilian Portuguese/ });
    const chips = within(within(panel).getByRole("group", { name: "Languages" })).getAllByRole(
      "button",
    );
    // The profile's language first (the file's own English subtitles and the
    // addon's three), then the rest by name.
    expect(chips.slice(1).map((chip) => chip.textContent)).toEqual([
      "English 5",
      "Brazilian Portuguese 4",
      "Croatian 1",
    ]);

    const portuguese = within(panel).getByRole("region", { name: "Brazilian Portuguese" });
    await user.click(
      within(portuguese).getByRole("button", {
        name: /The\.Shawshank\.Redemption\.1994.*PT-BR\.srt/,
      }),
    );
    expect(mocks.addSubtitle).toHaveBeenLastCalledWith({
      url: opensubtitlesMovie.subtitles[4]!.url,
      lang: "pt",
      title: "OpenSubtitles v3",
      secondary: false,
    });
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenLastCalledWith(1, {
        ...japanese,
        subtitleLanguage: "pt",
      }),
    );
  });

  it("keeps the language of the file's own subtitles picked", async () => {
    await openPlayer();
    emit("player:state", {
      ...withTracks,
      tracks: [...tracksSelecting(1, 0), track({ id: 5, type: "sub", lang: "jpn" })],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    await user.click(within(panel).getByRole("button", { name: /^Japanese.*In file/ }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(5);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenLastCalledWith(1, {
        ...japanese,
        subtitleLanguage: "ja",
      }),
    );
  });

  it("shows the subtitles menu for addon subtitles alone, and adds them again after a retry", async () => {
    serve();
    await openPlayer(undefined, source, target);
    emit("player:state", japaneseOnly);
    await waitFor(() => expect(mocks.addSubtitle).toHaveBeenCalledTimes(1));
    const added = track({ id: 10, type: "sub", lang: "en", external: true, selected: true });
    emit("player:state", { ...japaneseOnly, tracks: [...japaneseAudio, added] });
    expect(await screen.findByRole("button", { name: "Subtitles" })).toBeInTheDocument();

    emit("player:state", playing);
    emit("player:ended", { reason: "error", code: "failed" } satisfies Ended);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    expect(mocks.load).toHaveBeenLastCalledWith(
      source,
      expect.objectContaining({ subtitleLanguage: "en", captions: "on" }),
    );
    emit("player:state", japaneseOnly);
    await waitFor(() => expect(mocks.addSubtitle).toHaveBeenCalledTimes(2));
    expect(mocks.addSubtitle).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: firstEnglish }),
    );
  });

  it("says when they can't be loaded", async () => {
    serve();
    mocks.addSubtitle.mockRejectedValue(new Error("subtitles"));
    await openPlayer(undefined, source, target);
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    const panel = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    const files = await within(panel).findAllByRole("button", { name: /OpenSubtitles v3/ });
    await user.click(files[0]!);
    expect(await screen.findByText("Couldn’t load those subtitles")).toBeInTheDocument();
  });
});

const card = () => screen.findByRole("region", { name: "Next episode" });

describe("next episode", () => {
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
  const nextStreams = "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A2.json";
  // A cached Torrentio+TorBox stream of the next episode, and a torrent.
  const debrid = {
    name: "[TB+] Torrentio\n1080p",
    title: "Breaking.Bad.S01E02.1080p.BluRay.x264-GRP.mkv\n👤 20 💾 2.1 GB ⚙️ Tracker",
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/a/null/1/Breaking.Bad.S01E02.mkv",
  };
  const p2p = {
    name: "Torrentio\n1080p",
    title: "Breaking.Bad.S01E02.1080p.BluRay.x264-GRP.mkv\n👤 59 💾 2.1 GB ⚙️ Tracker",
    infoHash: "9cf3225d39f3a46c34cc149101dd8560c574a21b",
    fileIdx: 1,
    behaviorHints: { filename: "Breaking.Bad.S01E02.1080p.BluRay.x264-GRP.mkv" },
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
  // 58 minutes: it counts as watched from 52:12.
  const before: State = { ...playing, position: 3000, duration: 3480 };
  const watched: State = { ...playing, position: 3200, duration: 3480 };

  // Serves Cinemeta's details of Breaking Bad and Torrentio's streams for
  // its second episode.
  function serve(streams: unknown[]) {
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.visibleAddons.mockResolvedValue([cinemeta, torrentio]);
    const answers: Record<string, unknown> = {
      [cinemeta.url]: cinemetaManifest,
      [torrentio.url]: torrentioManifest,
      "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
      [nextStreams]: { streams },
    };
    const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
      url in answers ? Response.json(answers[url]) : new Response("", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const openPilot = (played = source) =>
    openPlayer("S1 · E1 · Pilot", played, undefined, { watching: pilot });

  // #58: the source the show last played from, not the ranked best.
  it("gets the stream matching the show's last source ready, and remembers it as it plays", async () => {
    const ntb = {
      name: "[TB+] Torrentio\n720p",
      title: "Breaking.Bad.S01E02.720p.WEB-DL.DDP5.1.H264-NTb.mkv\n👤 20 💾 1.1 GB ⚙️ Tracker",
      url: "https://torrentio.strem.fun/resolve/torbox/KEY/c/null/1/Breaking.Bad.S01E02.720p.mkv",
    };
    serve([debrid, ntb]);
    mocks.chosen.mockResolvedValue({
      source: torrentio.url,
      resolution: "720p",
      group: "NTb",
      chosenAt: 1,
    });
    await openPilot();
    emit("player:state", watched);
    const next = await card();
    expect(await within(next).findByText("720p from Torrentio")).toBeInTheDocument();
    expect(mocks.resolve).toHaveBeenCalledWith({ url: ntb.url, headers: {} });
    expect(mocks.resolve).not.toHaveBeenCalledWith({ url: debrid.url, headers: {} });

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() =>
      expect(mocks.setChosen).toHaveBeenCalledExactlyOnceWith(1, "tt0903747", {
        source: torrentio.url,
        resolution: "720p",
        group: "NTb",
        chosenAt: expect.any(Number),
      }),
    );
  });

  it("offers it once this one counts as watched, ready in advance, and plays it at the end", async () => {
    serve([debrid]);
    const { router } = await openPilot();
    emit("player:state", before);
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();

    emit("player:state", watched);
    const next = await card();
    expect(next).toHaveTextContent("S1 · E2 · Cat's in the Bag...");
    expect(next).toHaveTextContent("Up next · 4:40");
    expect(await within(next).findByText("1080p from Torrentio")).toBeInTheDocument();
    // Resolved before it's due.
    expect(mocks.resolve).toHaveBeenCalledWith({ url: debrid.url, headers: {} });
    expect(mocks.load).not.toHaveBeenCalled();

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: "https://cdn.example/KEY/fresh.mkv" }),
        expect.objectContaining({
          start: 0,
          audioLanguages: ["ja"],
          watching: expect.objectContaining({
            profileId: 1,
            contentId: "tt0903747",
            contentType: "series",
            videoId: "tt0903747:1:2",
            season: 1,
            episode: 2,
            title: "Cat's in the Bag...",
          }),
        }),
      ),
    );
    expect(await screen.findByText("S1 · E2 · Cat's in the Bag...")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/player");
    expect(router.state.location.state.player?.watching?.videoId).toBe("tt0903747:1:2");
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("plays it at once on Play now, from where it was left", async () => {
    serve([debrid]);
    mocks.titleProgress.mockResolvedValue([
      {
        key: "tt0903747_s1e2",
        contentId: "tt0903747",
        contentType: "series",
        videoId: "tt0903747:1:2",
        season: 1,
        episode: 2,
        position: 600_000,
        duration: 2_880_000,
        lastWatched: 1,
      } satisfies Progress,
    ]);
    await openPilot();
    emit("player:state", watched);
    const next = await card();
    await within(next).findByText("1080p from Torrentio");
    await userEvent.setup().click(within(next).getByRole("button", { name: "Play now" }));
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ start: 600 }),
      ),
    );
    emit("player:state", { ...playing, position: 600, duration: 2880 });
    expect(await screen.findByText("Resumed at")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();
  });

  it("leaves at the end once cancelled", async () => {
    serve([debrid]);
    const { router } = await openPilot();
    emit("player:state", watched);
    await userEvent.setup().click(within(await card()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("opens the picker for it when there's no stream", async () => {
    serve([]);
    const { router } = await openPilot();
    emit("player:state", watched);
    const next = await card();
    expect(await within(next).findByText("No stream found yet")).toBeInTheDocument();
    await userEvent.setup().click(within(next).getByRole("button", { name: "Choose a stream" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
    expect(router.state.location.search).toEqual({ video: "tt0903747:1:2" });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("opens a torrent only when it plays, in place of the one playing", async () => {
    serve([p2p]);
    const nextTorrent: Source = { ...torrent, url: "http://127.0.0.1:50123/secret/9cf3/1/e2.mkv" };
    mocks.openTorrent.mockResolvedValue(nextTorrent);
    await openPilot(torrent);
    emit("player:state", watched);
    const next = await card();
    expect(await within(next).findByText("1080p from Torrentio")).toBeInTheDocument();
    // Opening it now would stop the torrent playing.
    expect(mocks.openTorrent).not.toHaveBeenCalled();

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(nextTorrent, expect.anything()));
    expect(mocks.openTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ infoHash: p2p.infoHash, fileIdx: 1 }),
    );
    // Opening the next one replaced it.
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("lets the torrent playing go when the next comes from a link", async () => {
    serve([debrid]);
    await openPilot(torrent);
    emit("player:state", watched);
    const next = await card();
    await within(next).findByText("1080p from Torrentio");
    await userEvent.setup().click(within(next).getByRole("button", { name: "Play now" }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0]!,
    );
  });

  it("isn't offered for a film", async () => {
    serve([debrid]);
    await openPlayer(undefined, source, undefined, {
      watching: {
        profileId: 1,
        contentId: "tt0111161",
        contentType: "movie",
        videoId: "tt0111161",
      },
    });
    emit("player:state", watched);
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();
  });

  // W3: the party is on the next episode, so a guest follows it there. The
  // party's picker picks from the host's stream, so nothing prepares this
  // device's pick and Play it opens the picker instead of playing.
  const partyOnNext = (party: Parameters<typeof partyState>[0] = {}) =>
    partyState(
      { watching: false, ...party },
      {
        type: "series",
        id: "tt0903747",
        videoId: "tt0903747:1:2",
        season: 1,
        episode: 2,
        title: "Breaking Bad",
      },
    );

  it("sends a guest's Play it to the party's picker for its next episode", async () => {
    serve([debrid]);
    const { router } = await openPilot();
    emit("party:state", partyOnNext());
    emit("player:state", watched);

    expect(
      await screen.findByText("The party is watching Breaking Bad · S1 E2"),
    ).toBeInTheDocument();
    // The card would only get this device's pick ready.
    expect(screen.queryByRole("region", { name: "Next episode" })).not.toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: "Play it" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
    expect(router.state.location.search).toEqual({ video: "tt0903747:1:2" });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("goes to the party's picker at the end rather than playing its own pick", async () => {
    serve([debrid]);
    const { router } = await openPilot();
    emit("party:state", partyOnNext());
    emit("player:state", watched);
    await screen.findByText("The party is watching Breaking Bad · S1 E2");

    emit("player:ended", { reason: "eof" } satisfies Ended);
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("keeps the card and the prepared pick for the host", async () => {
    serve([debrid]);
    await openPilot();
    emit("party:state", partyOnNext({ isHost: true, hostId: "me" }));
    emit("player:state", watched);

    // The host moves the party to what it plays, and its own pick is ready.
    expect(
      await screen.findByRole("button", { name: "Switch the party to this" }),
    ).toBeInTheDocument();
    const next = await card();
    expect(await within(next).findByText("1080p from Torrentio")).toBeInTheDocument();
    expect(mocks.resolve).toHaveBeenCalledWith({ url: debrid.url, headers: {} });
  });
});

describe("stream switcher", () => {
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
  const pilotStreams = "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json";
  // Two cached Torrentio+TorBox streams of the pilot: the 720p one plays.
  const hd: Stream = {
    name: "[TB+] Torrentio\n720p",
    title: "Breaking.Bad.S01E01.720p.BluRay.x264-GRP.mkv\n👤 20 💾 1.1 GB ⚙️ Tracker",
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/b/null/1/Breaking.Bad.S01E01.720p.mkv",
  };
  const fullHd: Stream = {
    name: "[TB+] Torrentio\n1080p",
    title: "Breaking.Bad.S01E01.1080p.BluRay.x264-GRP.mkv\n👤 40 💾 2.1 GB ⚙️ Tracker",
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/a/null/1/Breaking.Bad.S01E01.1080p.mkv",
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

  function serve(streams: Stream[]) {
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.visibleAddons.mockResolvedValue([cinemeta, torrentio]);
    const answers: Record<string, unknown> = {
      [cinemeta.url]: cinemetaManifest,
      [torrentio.url]: torrentioManifest,
      "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
      [pilotStreams]: { streams },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string) => Promise<Response>>(async (url) =>
        url in answers ? Response.json(answers[url]) : new Response("", { status: 503 }),
      ),
    );
  }
  // jsdom has no layout, and without Tailwind the list's scroller isn't
  // found, so it's the page: give that a height or the list mounts no rows.
  beforeEach(() => {
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  const openPilot = () =>
    // As the app has it: the addon client copies a stream's `title` to `description`.
    openPlayer("S1 · E1 · Pilot", source, undefined, {
      watching: pilot,
      stream: { ...hd, description: hd.title ?? "" },
      resumedAt: 0,
    });

  it("tops the list with the show's last source, saying so", async () => {
    serve([hd, fullHd]);
    mocks.chosen.mockResolvedValue({
      source: torrentio.url,
      resolution: "720p",
      group: "GRP",
      chosenAt: 1,
    });
    await openPilot();
    emit("player:state", playing);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Streams" }));
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    const top = await within(panel).findByRole("button", { name: /^Top pick.+/ });
    await waitFor(() => expect(top).toHaveTextContent("Same source as last time"));
    expect(top).toHaveTextContent("720p");
    expect(top).toHaveTextContent("Playing");
  });

  it("lists the streams of what plays, the one playing marked, and plays the one picked from where this one is", async () => {
    serve([hd, fullHd]);
    const { router } = await openPilot();
    emit("player:state", playing);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Streams" }));
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    const top = await within(panel).findByRole("button", { name: /^Top pick.+/ });
    expect(top).toHaveTextContent("1080p");
    expect(top).not.toHaveTextContent("Playing");
    expect(await within(panel).findByRole("button", { name: /Playing/ })).toHaveTextContent("720p");

    // It has played on while the user chose.
    mocks.snapshot.mockResolvedValue({ ...playing, position: 642 });
    await user.click(top);
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: "https://cdn.example/KEY/fresh.mkv" }),
        expect.objectContaining({ start: 642, audioLanguages: ["ja"], watching: pilot }),
      ),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ url: fullHd.url, headers: {} });
    // The show's source from now on (#58).
    expect(mocks.setChosen).toHaveBeenCalledExactlyOnceWith(1, "tt0903747", {
      source: torrentio.url,
      resolution: "1080p",
      group: "GRP",
      chosenAt: expect.any(Number),
    });
    await waitFor(() =>
      expect(router.state.location.state.player?.source?.url).toBe(
        "https://cdn.example/KEY/fresh.mkv",
      ),
    );
    expect(router.state.location.state.player).toMatchObject({
      title: "The Film",
      episode: "S1 · E1 · Pilot",
      stream: fullHd,
      watching: pilot,
      resumedAt: 0,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/player");
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("opens on S, and closes on picking the one playing", async () => {
    serve([hd, fullHd]);
    await openPilot();
    emit("player:state", playing);
    await screen.findByRole("button", { name: "Pause" });
    const user = userEvent.setup();
    await user.keyboard("s");
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    // The player's keys are the panel's while it's open.
    await user.keyboard("k");
    expect(mocks.setPaused).not.toHaveBeenCalled();
    await user.click(await within(panel).findByRole("button", { name: /Playing/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("says why a stream can't be opened, and plays on", async () => {
    serve([hd, fullHd]);
    mocks.resolve.mockRejectedValue(new Error("unreachable"));
    const { router } = await openPilot();
    emit("player:state", playing);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Streams" }));
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    await user.click(await within(panel).findByRole("button", { name: /^Top pick.+/ }));
    expect(await within(panel).findByRole("alert")).toBeInTheDocument();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(router.state.location.state.player?.source).toEqual(source);
  });

  it("opens from a stream that stopped, and plays another from where it stopped", async () => {
    serve([hd, fullHd]);
    const { router } = await openPilot();
    emit("player:state", playing);
    await screen.findByRole("button", { name: "Pause" });
    emit("player:ended", { reason: "error", code: "unsupported" } satisfies Ended);
    const user = userEvent.setup();
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Choose another stream" }));
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    expect(router.state.location.pathname).toBe("/player");
    await user.click(await within(panel).findByRole("button", { name: /^Top pick.+/ }));
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ start: 600 }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Peli can’t play this file")).not.toBeInTheDocument(),
    );
  });

  it("lets the torrent playing go when the new stream comes from a link", async () => {
    serve([hd, fullHd]);
    await openPlayer("S1 · E1 · Pilot", torrent, undefined, { watching: pilot });
    emit("player:state", playing);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Streams" }));
    const panel = await screen.findByRole("dialog", { name: "Streams" });
    await user.click(await within(panel).findByRole("button", { name: /^Top pick.+/ }));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0]!,
    );
  });

  it("isn't offered without what plays", async () => {
    await openPlayer();
    emit("player:state", playing);
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("button", { name: "Streams" })).not.toBeInTheDocument();
  });

  // A guest in a watch party (ADR-0051) never chooses a stream: the party
  // picks one from the host's for them (lib/party-pick), so everything that
  // opens the switcher is the host's.
  describe("in a watch party", () => {
    // The party watches the pilot, as this device does: its media is this
    // player's own, so a guest here is a guest of the file playing.
    const partyMedia = {
      type: "series",
      id: "tt0903747",
      videoId: "tt0903747:1:1",
      season: 1,
      episode: 1,
      title: "Pilot",
    };
    const asGuest = () => partyState({ watching: true }, partyMedia);
    const asHost = () =>
      partyState(
        {
          isHost: true,
          hostId: "me",
          memberId: "me",
          watching: true,
          members: [
            partyMember({ id: "me", name: "Kevin", host: true, you: true }),
            partyMember({ id: "ana", name: "Ana" }),
          ],
        },
        partyMedia,
      );

    it("gives a guest no Streams button, and no S", async () => {
      await openPilot();
      emit("player:state", playing);
      emit("party:state", asGuest());
      await screen.findByRole("button", { name: "Pause" });

      expect(screen.queryByRole("button", { name: "Streams" })).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.keyboard("s");
      expect(screen.queryByRole("dialog", { name: "Streams" })).not.toBeInTheDocument();
      expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it("leaves S and the Streams panel out of a guest's shortcuts", async () => {
      await openPilot();
      emit("player:state", playing);
      emit("party:state", asGuest());
      await screen.findByRole("button", { name: "Pause" });
      const user = userEvent.setup();
      await user.keyboard("?");
      const help = await screen.findByRole("region", { name: "Keyboard shortcuts" });

      expect(within(help).queryByText("Choose another stream")).not.toBeInTheDocument();
      expect(within(help).queryByText("In the Streams panel")).not.toBeInTheDocument();
      expect(within(help).queryByText("S")).not.toBeInTheDocument();
      // The rest are still the guest's to read.
      expect(within(help).getByText("Next subtitles, then off")).toBeInTheDocument();
    });

    it("sends a guest whose stream failed to the party's picker", async () => {
      const { router } = await openPilot();
      emit("player:state", playing);
      emit("party:state", asGuest());
      await screen.findByRole("button", { name: "Pause" });
      emit("player:ended", { reason: "error", code: "unsupported" } satisfies Ended);
      const alert = await screen.findByRole("alert");

      expect(
        within(alert).queryByRole("button", { name: "Choose another stream" }),
      ).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(within(alert).getByRole("button", { name: "Try another stream" }));

      // The picker for the party's media, which picks from the host's stream.
      await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
      expect(router.state.location.search).toEqual({ video: "tt0903747:1:1" });
      expect(router.state.location.state.play).toMatchObject({
        type: "series",
        id: "tt0903747",
        videoId: "tt0903747:1:1",
      });
    });

    it("keeps the Streams button and S for the host", async () => {
      serve([hd, fullHd]);
      await openPilot();
      emit("player:state", playing);
      emit("party:state", asHost());
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Streams" }));
      const panel = await screen.findByRole("dialog", { name: "Streams" });
      await user.click(await within(panel).findByRole("button", { name: /Playing/ }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.keyboard("s");
      expect(await screen.findByRole("dialog", { name: "Streams" })).toBeInTheDocument();
    });
  });
});

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
// Video, English and Japanese audio, and English forced and SDH subtitles,
// with the given audio and subtitle tracks selected (0 for none).
const tracksSelecting = (audio: number, sub: number): Track[] => [
  track({ id: 1, type: "video", codec: "h264", selected: true }),
  track({ id: 1, type: "audio", lang: "eng", codec: "aac", channels: 2, selected: audio === 1 }),
  track({
    id: 2,
    type: "audio",
    lang: "jpn",
    title: "Commentary",
    codec: "ac3",
    channels: 6,
    selected: audio === 2,
  }),
  track({ id: 3, type: "sub", lang: "eng", title: "Signs", forced: true, selected: sub === 3 }),
  track({ id: 4, type: "sub", lang: "eng", hearingImpaired: true, selected: sub === 4 }),
];
const withTracks: State = { ...playing, tracks: tracksSelecting(1, 0) };
const english = tracksSelecting(1, 0)[1]!;

describe("skip intro and credits", () => {
  const pilot: Watching = {
    profileId: 1,
    contentId: "tt0903747",
    contentType: "series",
    videoId: "tt0903747:1:1",
    season: 1,
    episode: 1,
    title: "Pilot",
  };
  const film: Watching = {
    profileId: 1,
    contentId: "tt0371746",
    contentType: "movie",
    videoId: "tt0371746",
  };
  // A 25-minute episode whose chapters name its opening and ending.
  const chaptered: State = {
    ...playing,
    position: 70,
    duration: 1500,
    chapters: [
      { title: "Prologue", time: 0 },
      { title: "Opening", time: 60 },
      { title: "Part A", time: 150 },
      { title: "Ending", time: 1410 },
    ],
  };

  it("skips an intro the file's chapters name", async () => {
    await openPlayer("S1 · E1");
    emit("player:state", { ...chaptered, position: 30 });
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();

    emit("player:state", chaptered);
    await userEvent.click(await screen.findByRole("button", { name: "Skip intro" }));
    expect(mocks.seek).toHaveBeenLastCalledWith(150);
    // Nothing to ask IntroDB about.
    expect(mocks.segments).not.toHaveBeenCalled();
  });

  it("asks IntroDB for an episode without chapters", async () => {
    mocks.segments.mockResolvedValue([{ kind: "intro", start: 216, end: 232 }]);
    await openPlayer("S1 · E1 · Pilot", source, undefined, { watching: pilot });
    emit("player:state", { ...playing, position: 220, duration: 3480 });
    expect(await screen.findByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    expect(mocks.segments).toHaveBeenCalledWith({ imdbId: "tt0903747", season: 1, episode: 1 });
  });

  it("marks the intro and credits on the seek bar", async () => {
    await openPlayer("S1 · E1");
    emit("player:state", chaptered);
    const bar = await screen.findByTestId("seek-bar");
    await waitFor(() => expect(within(bar).getAllByTestId("segment")).toHaveLength(2));
    const [intro, credits] = within(bar).getAllByTestId("segment");
    expect(intro).toHaveAttribute("data-kind", "intro");
    expect(intro!.style.left).toBe("4%");
    // A marker is at least 4px wide, however short.
    expect(intro!.style.width).toBe("max(4px, 6%)");
    expect(credits).toHaveAttribute("data-kind", "credits");
    expect(credits!.style.left).toBe("94%");
    expect(credits!.style.width).toBe("max(4px, 6%)");

    // The pointer over one names it.
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 20 }),
    );
    fireEvent.pointerMove(bar, { clientX: 960 });
    expect(within(bar).getByText("Credits")).toBeInTheDocument();
    fireEvent.pointerMove(bar, { clientX: 500 });
    expect(within(bar).queryByText("Credits")).not.toBeInTheDocument();
  });

  it("skips a film's credits to where they end", async () => {
    mocks.segments.mockResolvedValue([{ kind: "credits", start: 7038, end: 7140 }]);
    await openPlayer(undefined, source, undefined, { watching: film });
    emit("player:state", { ...playing, position: 7050, duration: 7200 });
    await userEvent.click(await screen.findByRole("button", { name: "Skip credits" }));
    expect(mocks.segments).toHaveBeenCalledWith({ imdbId: "tt0371746", season: 0, episode: 0 });
    expect(mocks.seek).toHaveBeenLastCalledWith(7140);
  });

  it("doesn't ask IntroDB when Settings say not to", async () => {
    mocks.deviceSettings.mockResolvedValue({
      hardwareDecoding: true,
      maxResolution: "auto",
      hdr: "auto",
      dolbyVision: "auto",
      skipTimesOnline: false,
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
    });
    mocks.segments.mockResolvedValue([{ kind: "intro", start: 216, end: 232 }]);
    await openPlayer("S1 · E1 · Pilot", source, undefined, { watching: pilot });
    emit("player:state", { ...playing, position: 220, duration: 3480 });
    await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => expect(mocks.deviceSettings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
    expect(mocks.segments).not.toHaveBeenCalled();
  });

  it("skips intros by itself when the profile says so, once each", async () => {
    mocks.settings.mockResolvedValue({ ...japanese, skipIntros: true });
    await openPlayer("S1 · E1");
    emit("player:state", chaptered);
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(150));
    expect(await screen.findByText("Skipped the intro")).toBeInTheDocument();

    // Back into it: the button, not another skip.
    emit("player:state", { ...chaptered, position: 150 });
    emit("player:state", { ...chaptered, position: 80 });
    expect(await screen.findByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    expect(mocks.seek).toHaveBeenCalledOnce();

    // Credits are the user's to skip.
    emit("player:state", { ...chaptered, position: 1420 });
    expect(await screen.findByRole("button", { name: "Skip credits" })).toBeInTheDocument();
    expect(mocks.seek).toHaveBeenCalledOnce();
  });
});

// The player's own box: the controls' parent.
const root = () => screen.getByTestId("controls").parentElement!;

describe("watch party", () => {
  const watching: Watching = {
    profileId: 1,
    contentId: "tt0111161",
    contentType: "movie",
    videoId: "tt0111161",
    title: "The Film",
    name: "The Film",
  };
  const media = {
    type: "movie",
    id: "tt0111161",
    videoId: "",
    season: null,
    episode: null,
    title: "The Film",
    episodeTitle: "",
    description: "",
    poster: "",
    background: "",
    logo: "",
    source: null,
  };
  const inParty = (more: Record<string, unknown> = {}) => ({
    unavailable: "",
    busy: false,
    party: {
      id: "p1",
      code: "ABCDEF",
      memberId: "me",
      hostId: "me",
      isHost: true,
      hostOnly: false,
      canControl: true,
      connected: true,
      maxMembers: 8,
      members: [
        {
          id: "me",
          name: "Kevin",
          avatarUrl: "",
          avatarColor: "",
          host: true,
          you: true,
          status: "ready",
          watchingElse: false,
          behindMs: 0,
        },
        {
          id: "ana",
          name: "Ana",
          avatarUrl: "",
          avatarColor: "",
          host: false,
          you: false,
          status: "loading",
          watchingElse: false,
          behindMs: 0,
        },
      ],
      media,
      watching: true,
      paused: true,
      waiting: true,
      waitingFor: ["Ana"],
      behind: false,
      behindMs: 0,
      sharing: false,
      shared: null,
      ...more,
    },
  });

  it("tells the party what plays, and that it stopped on leaving", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    await waitFor(() =>
      expect(Party.Watch).toHaveBeenCalledWith(media, expect.objectContaining({ url: source.url })),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(Party.Watch).toHaveBeenLastCalledWith(null, null));
  });

  // Watch parties are in the iOS app too (ADR-0063): what plays is told to the
  // party there as on the desktop, and the leaving call still runs.
  it("tells the party what plays on an iPhone, and that it stopped on leaving", async () => {
    const restore = onCompactIOS();
    onTestFinished(restore);
    await openPlayer(undefined, source, undefined, { watching });
    await waitFor(() =>
      expect(Party.Watch).toHaveBeenCalledWith(media, expect.objectContaining({ url: source.url })),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(Party.Watch).toHaveBeenLastCalledWith(null, null));
  });

  // The touch player's own way in: a 44 pt Users button in its top row, which
  // opens the sheet W opens, as a bottom sheet on an iPhone.
  it("opens the party sheet from the top row's Watch party button", async () => {
    const restore = onCompactIOS();
    onTestFinished(restore);
    await openPlayer(undefined, source, undefined, { watching });
    // The controls show once a state arrives, as in the other touch tests.
    emit("player:state", playing);
    const top = await screen.findByTestId("top-row");
    const button = await within(top).findByRole("button", { name: "Watch party" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    const user = userEvent.setup();
    await user.click(button);

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    expect(sheet).toHaveAttribute("data-slot", "bottom-sheet");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    // The same button, under the sheet's backdrop: the sheet is open.
    expect(button).toHaveAttribute("aria-expanded", "true");
    // The same sheet as W's: start one for what plays, or join one.
    expect(within(sheet).getByRole("button", { name: "Start a watch party" })).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "Party code" })).toBeInTheDocument();
  });

  it("starts one for what plays from W", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    emit("player:state", playing);
    const user = userEvent.setup();
    await user.keyboard("w");
    await user.click(await screen.findByRole("button", { name: "Start a watch party" }));
    expect(Party.Create).toHaveBeenCalledExactlyOnceWith(media);
  });

  // The reactions (ADR-0051's addendum) are the player's chrome now: a row of
  // emoji above the seek bar, so reacting is a click on the picture rather
  // than a trip to the sheet's chat.
  it("shows the reactions above the seek bar in a party, and only then", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    emit("player:state", playing);
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("group", { name: "Reactions" })).not.toBeInTheDocument();

    emit("party:state", inParty());
    const controls = screen.getByTestId("controls");
    const bar = await within(controls).findByRole("group", { name: "Reactions" });
    expect(within(bar).getByRole("button", { name: "React with fire" })).toBeInTheDocument();
    // The dock's: the timeline is under it.
    expect(within(controls).getByTestId("seek-bar")).toBeInTheDocument();

    // The mini player has no room for them.
    emit("player:state", { ...playing, mini: true });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Reactions" })).not.toBeInTheDocument(),
    );
  });

  it("sends the emoji clicked in the chrome, without pausing", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    emit("player:state", playing);
    emit("party:state", inParty());
    const fire = await screen.findByRole("button", { name: "React with fire" });
    await waitFor(() => expect(fire).toBeEnabled());
    const user = userEvent.setup();
    mocks.setPaused.mockClear();
    mocks.setFullscreen.mockClear();

    await user.click(fire);

    expect(Party.SendReaction).toHaveBeenCalledWith("🔥");
    // The click was the emoji's: the picture under it took nothing, and the
    // emoji didn't keep the focus Space needs to pause.
    expect(mocks.setPaused).not.toHaveBeenCalled();
    expect(mocks.setFullscreen).not.toHaveBeenCalled();
    expect(fire).not.toHaveFocus();
  });

  // The same row in the touch chrome (#130, ADR-0063): above its seek row.
  it("puts the reactions above the touch player's seek row", async () => {
    const restore = onCompactIOS();
    onTestFinished(restore);
    await openPlayer(undefined, source, undefined, { watching });
    emit("player:state", playing);
    emit("party:state", inParty());

    const bar = await screen.findByRole("group", { name: "Reactions" });
    // The chrome's bottom bar holds both, the emoji over the timeline.
    expect(within(bar.parentElement!).getByTestId("seek-row")).toBeInTheDocument();

    const user = userEvent.setup();
    mocks.setPaused.mockClear();
    await user.click(within(bar).getByRole("button", { name: "React with fire" }));

    expect(Party.SendReaction).toHaveBeenCalledWith("🔥");
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  describe("docked", () => {
    beforeEach(() => {
      mocks.dock.docked = true;
    });

    it("shows the dock instead of the sheet, and the picture makes room", async () => {
      await openPlayer(undefined, source, undefined, { watching });
      emit("player:state", playing);
      await screen.findByRole("button", { name: "Pause" });
      expect(root().style.getPropertyValue("--party-dock-w")).toBe("0px");
      expect(mocks.setVideoInset).not.toHaveBeenCalled();

      const user = userEvent.setup();
      await user.keyboard("w");
      expect(await screen.findByRole("complementary", { name: "Party dock" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Watch party" })).not.toBeInTheDocument();
      expect(root().style.getPropertyValue("--party-dock-w")).toBe("22rem");
      // 22 rem at the root font size (16 px), where jsdom measures nothing.
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(352));

      // W again closes it, and the picture has its room back.
      await user.keyboard("w");
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(0));
      expect(screen.queryByRole("complementary", { name: "Party dock" })).not.toBeInTheDocument();
      expect(root().style.getPropertyValue("--party-dock-w")).toBe("0px");
    });

    it("gives the room back on close, in the mini player and on leaving", async () => {
      await openPlayer(undefined, source, undefined, { watching });
      emit("player:state", playing);
      await screen.findByRole("button", { name: "Pause" });
      const user = userEvent.setup();
      await user.keyboard("w");
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(352));

      await user.click(screen.getByRole("button", { name: "Close dock" }));
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(0));

      // The mini player hides the dock and keeps the party open: back from
      // it, the dock is there again.
      await user.keyboard("w");
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(352));
      emit("player:state", { ...playing, mini: true });
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(0));
      expect(screen.queryByRole("complementary", { name: "Party dock" })).not.toBeInTheDocument();
      emit("player:state", { ...playing, mini: false });
      expect(await screen.findByRole("complementary", { name: "Party dock" })).toBeInTheDocument();
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(352));

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(mocks.setVideoInset).toHaveBeenLastCalledWith(0));
    });

    it("keeps the player's keys, but not while typing in the chat", async () => {
      await openPlayer(undefined, source, undefined, { watching });
      emit("player:state", playing);
      await screen.findByRole("button", { name: "Pause" });
      const user = userEvent.setup();
      await user.keyboard("w");
      const chat = await screen.findByRole("textbox", { name: "Chat message" });

      await user.keyboard("k");
      expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
      mocks.setPaused.mockClear();
      mocks.setFullscreen.mockClear();

      await user.click(chat);
      await user.keyboard("k m f");
      expect(chat).toHaveValue("k m f");
      expect(mocks.setPaused).not.toHaveBeenCalled();
      expect(mocks.setFullscreen).not.toHaveBeenCalled();

      // Esc leaves the field, and nothing else: the dock stays, and so does
      // the window's full screen.
      await user.keyboard("{Escape}");
      expect(chat).not.toHaveFocus();
      expect(screen.getByRole("complementary", { name: "Party dock" })).toBeInTheDocument();
      expect(mocks.setFullscreen).not.toHaveBeenCalled();
      await user.keyboard("k");
      expect(mocks.setPaused).toHaveBeenCalled();
    });
  });

  it("shows the code, the people and who it waits for", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    emit("party:state", inParty());
    expect(await screen.findByText("Waiting for Ana")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Watch party" }));
    expect(await screen.findByText("ABC DEF")).toBeInTheDocument();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Ana" })).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Only I can control playback/ }));
    expect(Party.SetHostOnly).toHaveBeenCalledWith(true);
  });

  it("offers to catch up while behind, and says what others did", async () => {
    await openPlayer(undefined, source, undefined, { watching });
    emit(
      "party:state",
      inParty({
        isHost: false,
        hostId: "ana",
        canControl: false,
        hostOnly: true,
        waiting: false,
        behind: true,
        behindMs: 80_000,
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Catch up" }));
    expect(Party.CatchUp).toHaveBeenCalled();
    expect(screen.getByText("You’re 1:20 behind the party")).toBeInTheDocument();
    emit("party:notice", {
      kind: "action",
      name: "Ana",
      action: "paused",
      positionMs: 0,
      rate: 1,
      media: null,
      hostOnly: false,
    });
    expect(await screen.findByText("Ana paused")).toBeInTheDocument();
  });

  it("offers to follow the party when it watches something else", async () => {
    const { router } = await openPlayer(undefined, source, undefined, { watching });
    const other = {
      ...media,
      type: "series",
      id: "tt0903747",
      videoId: "tt0903747:1:1",
      season: 1,
      episode: 1,
      title: "Breaking Bad",
    };
    emit("party:state", inParty({ isHost: false, hostId: "ana", media: other, watching: false }));
    expect(
      await screen.findByText("The party is watching Breaking Bad · S1 E1"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Watch with the party" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
    expect(router.state.location.search).toEqual({ video: "tt0903747:1:1" });
  });
});

// A guest follows the host onto another stream (ADR-0051): the chooser runs
// again against the host's new source and the pick loads where this guest is.
describe("watch party: following the host's stream", () => {
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
  const pilotStreams = "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json";
  const hd: Stream = {
    name: "[TB+] Torrentio\n720p",
    title: "Breaking.Bad.S01E01.720p.BluRay.x264-GRP.mkv\n👤 20 💾 1.1 GB ⚙️ Tracker",
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/b/null/1/Breaking.Bad.S01E01.720p.mkv",
  };
  const fullHd: Stream = {
    name: "[TB+] Torrentio\n1080p",
    title: "Breaking.Bad.S01E01.1080p.BluRay.x264-GRP.mkv\n👤 40 💾 2.1 GB ⚙️ Tracker",
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/a/null/1/Breaking.Bad.S01E01.1080p.mkv",
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
  const hostSource = (name: string) => ({
    infoHash: "",
    fileIdx: null,
    filename: "",
    videoSize: 0,
    bingeGroup: "",
    addonId: "torrentio",
    name,
  });
  const people = [
    { id: "me", name: "Kevin", host: false, you: true },
    { id: "ana", name: "Ana", host: true, you: false },
  ].map((member) => ({
    avatarUrl: "",
    avatarColor: "",
    status: "ready",
    watchingElse: false,
    behindMs: 0,
    ...member,
  }));
  const partyMedia = (name: string) => ({
    type: "series",
    id: "tt0903747",
    videoId: "tt0903747:1:1",
    season: 1,
    episode: 1,
    title: "Breaking Bad",
    episodeTitle: "Pilot",
    description: "",
    poster: "",
    background: "",
    logo: "",
    source: hostSource(name),
  });
  const partyState = (name: string, more: Record<string, unknown> = {}) => ({
    unavailable: "",
    busy: false,
    party: {
      id: "p1",
      code: "ABCDEF",
      memberId: "me",
      hostId: "ana",
      isHost: false,
      hostOnly: false,
      canControl: true,
      connected: true,
      maxMembers: 8,
      members: people,
      media: partyMedia(name),
      watching: true,
      paused: false,
      waiting: false,
      waitingFor: [],
      behind: false,
      behindMs: 0,
      sharing: false,
      shared: null,
      ...more,
    },
  });
  // The host switches: the party's state carries the new source, then the
  // notice says so.
  const hostSwitches = (name: string, more: Record<string, unknown> = {}) => {
    emit("party:state", partyState(name, more));
    emit("party:notice", {
      kind: "source",
      name: "",
      action: "",
      positionMs: 0,
      rate: 1,
      media: partyMedia(name),
      hostOnly: false,
    });
  };
  const openPilot = () =>
    openPlayer("S1 · E1 · Pilot", source, undefined, {
      watching: pilot,
      stream: { ...hd, description: hd.title ?? "" },
      resumedAt: 0,
    });

  beforeEach(() => {
    mocks.addons.mockResolvedValue([cinemeta, torrentio]);
    mocks.visibleAddons.mockResolvedValue([cinemeta, torrentio]);
    const answers: Record<string, unknown> = {
      [cinemeta.url]: cinemetaManifest,
      [torrentio.url]: torrentioManifest,
      "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
      [pilotStreams]: { streams: [hd, fullHd] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string) => Promise<Response>>(async (url) =>
        url in answers ? Response.json(answers[url]) : new Response("", { status: 503 }),
      ),
    );
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  it("switches to the stream that matches the host's, from where this guest is, remembering nothing", async () => {
    await openPilot();
    emit("player:state", playing);
    emit("party:state", partyState("[TB+] Torrentio\n720p"));
    await screen.findByRole("button", { name: "Pause" });
    mocks.snapshot.mockResolvedValue({ ...playing, position: 642 });
    hostSwitches("[TB+] Torrentio\n1080p");
    expect(await screen.findByText(/Ana switched streams: switching too/)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: "https://cdn.example/KEY/fresh.mkv" }),
        expect.objectContaining({ start: 642, watching: pilot }),
      ),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ url: fullHd.url, headers: {} });
    // The party's pick isn't the guest's habit.
    expect(mocks.setChosen).not.toHaveBeenCalled();
  });

  it("does nothing when the chooser lands on what plays", async () => {
    await openPilot();
    emit("player:state", playing);
    emit("party:state", partyState("[TB+] Torrentio\n1080p"));
    await screen.findByRole("button", { name: "Pause" });
    hostSwitches("[TB+] Torrentio\n720p");
    await waitFor(() =>
      expect(screen.queryByText(/switched streams: switching too/)).not.toBeInTheDocument(),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("follows the latest switch when the host switches again mid-switch", async () => {
    let release: (value: Source) => void = () => {};
    mocks.resolve.mockImplementationOnce(() => new Promise<Source>((done) => (release = done)));
    await openPilot();
    emit("player:state", playing);
    emit("party:state", partyState("[TB+] Torrentio\n720p"));
    await screen.findByRole("button", { name: "Pause" });
    hostSwitches("[TB+] Torrentio\n1080p");
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    // Back to the one playing: the first pick is dropped, whatever it resolves to.
    hostSwitches("[TB+] Torrentio\n720p");
    release({ ...source, url: "https://cdn.example/KEY/stale.mkv" });
    await waitFor(() =>
      expect(screen.queryByText(/switched streams: switching too/)).not.toBeInTheDocument(),
    );
    expect(mocks.load).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://cdn.example/KEY/stale.mkv" }),
      expect.anything(),
    );
  });

  it("plays on and offers to try again when nothing opens", async () => {
    mocks.resolve.mockRejectedValue(new Error("unreachable"));
    const { router } = await openPilot();
    emit("player:state", playing);
    emit("party:state", partyState("[TB+] Torrentio\n720p"));
    await screen.findByRole("button", { name: "Pause" });
    hostSwitches("[TB+] Torrentio\n1080p");
    expect(await screen.findByText("Couldn’t switch to Ana’s new stream")).toBeInTheDocument();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(router.state.location.state.player?.source).toEqual(source);
    mocks.resolve.mockResolvedValue({ ...source, url: "https://cdn.example/KEY/fresh.mkv" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
  });
});

// The touch player's chrome (#130): a small top row, the transport in the
// middle, a thin seek row and, for a series, a row of text buttons.
describe("touch player", () => {
  const pilot: Watching = {
    profileId: 1,
    contentId: "tt0903747",
    contentType: "series",
    videoId: "tt0903747:1:1",
    season: 1,
    episode: 1,
    title: "Pilot",
  };
  const cinemeta: Addon = {
    url: "https://v3-cinemeta.strem.io/manifest.json",
    name: "Cinemeta",
    enabled: true,
  };
  function serveSeries() {
    mocks.addons.mockResolvedValue([cinemeta]);
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    const answers: Record<string, unknown> = {
      [cinemeta.url]: cinemetaManifest,
      "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string) => Promise<Response>>(async (url) =>
        url in answers ? Response.json(answers[url]) : new Response("", { status: 503 }),
      ),
    );
  }
  beforeEach(() => onIOS());
  afterEach(() => vi.unstubAllGlobals());

  it("has a top row, the transport in the middle and a seek row, with no dock menus", async () => {
    // An iPhone: at regular width (an iPad, #138) the bottom row always shows.
    const restore = onCompactIOS();
    onTestFinished(restore);
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();
    const top = await screen.findByTestId("top-row");
    expect(within(top).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(within(top).getByRole("heading", { name: "The Film" })).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "Audio and subtitles" })).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "More" })).toBeInTheDocument();
    // #131's Lock sits in the top row too.
    expect(within(top).getByRole("button", { name: "Lock the controls" })).toBeInTheDocument();
    // The old dock's separate menus are gone.
    expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
    // A film has no bottom row.
    expect(screen.queryByTestId("bottom-row")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(mocks.seek).toHaveBeenLastCalledWith(610);
    const row = screen.getByTestId("seek-row");
    expect(within(row).getByTestId("elapsed")).toHaveTextContent("10:10");
    expect(within(row).getByTestId("remaining")).toHaveTextContent("-1:49:50");
    expect(within(row).getByRole("slider", { name: "Seek" })).toBeInTheDocument();

    // A film's speed is in More.
    await user.click(screen.getByRole("button", { name: "More" }));
    const more = await screen.findByRole("menu");
    expect(within(more).getByRole("menuitem", { name: /Speed/ })).toBeInTheDocument();
    expect(
      within(more).getByRole("menuitemcheckbox", { name: "Playback stats" }),
    ).toBeInTheDocument();
    expect(within(more).getByRole("menuitem", { name: /Sleep timer/ })).toBeInTheDocument();
  });

  it("picks audio and subtitles in one sheet, and times them there", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Audio and subtitles" }));
    const sheet = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    const audio = within(sheet).getByRole("region", { name: "Audio" });
    const subtitles = within(sheet).getByRole("region", { name: "Subtitles" });
    expect(within(audio).getByRole("button", { name: /^English/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(audio).getByRole("button", { name: /^Japanese/ }));
    expect(mocks.setAudioTrack).toHaveBeenLastCalledWith(2);
    expect(within(subtitles).getByRole("button", { name: "Off" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(subtitles).getByRole("button", { name: /SDH/ }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(4);

    await user.click(within(sheet).getByRole("button", { name: /^Timing/ }));
    await user.click(within(sheet).getByRole("button", { name: "Later" }));
    await waitFor(() => expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(0.1));
    expect(within(sheet).getAllByText("0.1 s later").length).toBeGreaterThan(0);

    // Style opens the panel's Style tab, with the size.
    await user.click(within(sheet).getByRole("button", { name: /^Subtitle style/ }));
    expect(await screen.findByRole("tab", { name: "Style" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("lists addon subtitles in the sheet by language, and adds the one picked", async () => {
    const opensubtitles: Addon = {
      url: "https://opensubtitles-v3.strem.io/manifest.json",
      name: "OpenSubtitles v3",
      enabled: true,
    };
    const asked =
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161/filename=film.mkv.json";
    mocks.addons.mockResolvedValue([opensubtitles]);
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string) => Promise<Response>>(async (url) =>
        url === opensubtitles.url
          ? Response.json(opensubtitlesManifest)
          : url === asked
            ? Response.json(opensubtitlesMovie)
            : new Response("", { status: 503 }),
      ),
    );
    await openPlayer(undefined, source, {
      type: "movie",
      id: "tt0111161",
      extra: { filename: "film.mkv" },
    });
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Audio and subtitles" }));
    const sheet = await screen.findByRole("dialog", { name: "Audio and subtitles" });
    // The profile's language first, as the desktop submenus have it.
    const groups = await within(sheet).findAllByRole("group");
    expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual([
      "English",
      "Brazilian Portuguese",
      "Croatian",
    ]);
    await user.click(within(groups[1]!).getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(mocks.addSubtitle).toHaveBeenCalledWith(expect.objectContaining({ lang: "pt" })),
    );
  });

  it("scrubs with the time and how far large at the centre, and fades the rest", async () => {
    await openPlayer();
    emit("player:state", playing);
    const bar = await screen.findByTestId("seek-bar");
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 24 }),
    );
    // jsdom has no pointer capture.
    Object.assign(HTMLElement.prototype, {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => true,
    });
    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerMove(bar, { clientX: 600, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(document, { clientX: 610, pointerId: 1, buttons: 1 });
    const label = await screen.findByTestId("scrub-label");
    // 61 % of two hours, and how far that is from 10:00.
    expect(label).toHaveTextContent("1:13:12+1:03:12");
    expect(screen.getByTestId("top-row")).toHaveClass("opacity-0");
    expect(mocks.scrub).toHaveBeenCalled();
    fireEvent.pointerUp(bar, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => expect(screen.queryByTestId("scrub-label")).not.toBeInTheDocument());
    expect(mocks.seek).toHaveBeenCalled();
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"])
      Reflect.deleteProperty(HTMLElement.prototype, name);
  });

  it("offers Start over at the top", async () => {
    await openPlayer(undefined, source, undefined, { resumedAt: 600 });
    emit("player:state", playing);
    expect(await screen.findByText(/^Resumed at/)).toHaveTextContent("Resumed at 10:00");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(mocks.seek).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("has Speed, Episodes and Next episode under the seek bar for a series", async () => {
    serveSeries();
    const { router } = await openPlayer("S1 · E1 · Pilot", source, undefined, {
      watching: pilot,
    });
    emit("player:state", { ...playing, duration: 3480 });
    const row = await screen.findByTestId("bottom-row");
    expect(within(row).getByRole("button", { name: /Playback speed, 1×/ })).toBeInTheDocument();
    expect(await within(row).findByRole("button", { name: "Next episode" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Episodes" }));
    const sheet = await screen.findByRole("dialog", { name: "Episodes" });
    expect(within(sheet).getByRole("button", { name: /Pilot/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(within(sheet).getByRole("button", { name: /Cat's in the Bag/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/series/tt0903747"));
    expect(router.state.location.search).toEqual({ video: "tt0903747:1:2" });
  });
});
