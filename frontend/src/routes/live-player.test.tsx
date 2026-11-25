import { act, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as Runtime from "@wailsio/runtime";
import type { Ended, State } from "@bindings/player";
import type { DeviceSettings, Profile, ProfileSettings } from "@bindings/store";
import type { Source as StreamSource } from "@bindings/streams";
import { LiveTV, type Channel, type NowNext, type Programme, type Source } from "@/lib/livetv";
import { idleState } from "@/lib/player";
import { deviceSettings, profileSettings } from "@/test/fixtures";
import { renderApp } from "@/test/render-app";

// The live player (ADR-0066, W7): a channel, its now programme, the group's
// neighbours on Page Up and Page Down, a DVR seek row when there is one, and
// "Channel unavailable" instead of the film player's error screen. Nothing of
// the film player's extras is here, so most of this file is about absence.

// The app is several queries deep and loads a lot of code on the first test,
// so a loaded machine needs more than the defaults.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

const mocks = vi.hoisted(() => ({
  // Every listener of each event, as the runtime keeps them.
  handlers: new Map<string, Set<(event: { data: unknown }) => void>>(),
  snapshot: vi.fn<() => Promise<State>>(),
  load: vi.fn<(source: StreamSource, opts: { start: number }) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  setPaused: vi.fn<(paused: boolean) => Promise<void>>(),
  setMuted: vi.fn<(muted: boolean) => Promise<void>>(),
  setVolume: vi.fn<(volume: number) => Promise<void>>(),
  setFullscreen: vi.fn<(on: boolean) => Promise<void>>(),
  seek: vi.fn<(position: number) => Promise<void>>(),
  scrub: vi.fn<(position: number) => Promise<void>>(),
  seekBy: vi.fn<(delta: number) => Promise<void>>(),
  setNowPlaying: vi.fn<(np: { title: string; subtitle: string }) => Promise<void>>(),
  systemCaptions: vi.fn<() => Promise<boolean>>(),
  settings: vi.fn<() => Promise<ProfileSettings>>(),
  deviceSettings: vi.fn<() => Promise<DeviceSettings>>(),
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
    SetPaused: mocks.setPaused,
    SetMuted: mocks.setMuted,
    SetVolume: mocks.setVolume,
    SetFullscreen: mocks.setFullscreen,
    Seek: mocks.seek,
    Scrub: mocks.scrub,
    SeekBy: mocks.seekBy,
    SetNowPlaying: mocks.setNowPlaying,
    SystemCaptions: mocks.systemCaptions,
  },
}));

const kevin: Profile = { id: 1, name: "Kevin", nuvioIndex: 1 };

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    ProfileSettings: mocks.settings,
    SaveProfileSettings: () => Promise.resolve(),
    DeviceSettings: mocks.deviceSettings,
    Addons: () => Promise.resolve([]),
    VisibleAddons: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
    ChosenSource: () => Promise.resolve(null),
    SetChosenSource: () => Promise.resolve(),
    TitleAdjustments: () => Promise.resolve(null),
    SetTitleAdjustments: () => Promise.resolve(),
    // iOS only: seeds the profile's audio languages from the device's.
    SeedAudioLanguages: () => Promise.resolve(false),
  },
}));

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

type ChannelId = "src:aaa" | "src:bbb" | "src:ccc";

// The one playlist the tests have: three channels in one group.
const channels: Channel[] = [
  {
    id: "src:aaa",
    sourceId: "src",
    number: 1,
    name: "News One",
    logo: "",
    group: "",
    tvgId: "",
    tvgName: "",
  },
  {
    id: "src:bbb",
    sourceId: "src",
    number: 2,
    name: "News Two",
    logo: "",
    group: "",
    tvgId: "",
    tvgName: "",
  },
  {
    id: "src:ccc",
    sourceId: "src",
    number: 3,
    name: "News Three",
    logo: "",
    group: "",
    tvgId: "",
    tvgName: "",
  },
];

// What each channel shows now, so its heading is its own.
const nowTitles: Record<ChannelId, string> = {
  "src:aaa": "Breakfast News",
  "src:bbb": "Midday News",
  "src:ccc": "Evening News",
};

const programme = (
  channelId: ChannelId,
  start: number,
  stop: number,
  title: string,
): Programme => ({
  channelId,
  start,
  stop,
  title,
  subTitle: "",
  description: "",
  categories: [],
  episode: "",
  icon: "",
});

const nowNext: NowNext[] = [
  {
    channelId: "src:aaa",
    now: programme("src:aaa", 1_800_000_000_000, 1_800_003_600_000, nowTitles["src:aaa"]),
    next: programme("src:aaa", 1_800_003_600_000, 1_800_007_200_000, "Late News"),
  },
  {
    channelId: "src:bbb",
    now: programme("src:bbb", 1_800_000_000_000, 1_800_003_600_000, nowTitles["src:bbb"]),
    next: null,
  },
  {
    channelId: "src:ccc",
    now: programme("src:ccc", 1_800_000_000_000, 1_800_003_600_000, nowTitles["src:ccc"]),
    next: null,
  },
];

// What LiveTV.Stream hands over once a channel is asked for: the link has a
// token in it, as an Xtream one would, so nothing may show it.
const live: StreamSource = {
  url: "https://iptv.example/live/K3V/news.m3u8",
  origin: "https://iptv.example/live/K3V/news.m3u8",
  headers: {},
  userAgent: "Peli/test",
  contentType: "application/vnd.apple.mpegurl",
  size: 0,
};

const emit = (name: string, data: unknown) =>
  act(() => {
    for (const listener of mocks.handlers.get(name) ?? []) listener({ data });
  });

// A live stream at the live edge of a one-hour DVR window.
const playing: State = {
  ...idleState,
  active: true,
  seekable: true,
  position: 3000,
  duration: 3600,
};

async function openChannel(channelId: ChannelId = "src:aaa") {
  const app = await renderApp("/library", { shell: false });
  await act(() =>
    app.router.navigate({
      to: "/player",
      state: (state) => ({
        ...state,
        player: { title: "News One", source: live, live: { channelId, group: "" } },
      }),
    }),
  );
  await screen.findByRole("heading", { name: nowTitles[channelId] });
  return app;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.snapshot.mockReset().mockResolvedValue({ ...idleState, active: true, loading: true });
  mocks.load.mockReset().mockResolvedValue(undefined);
  for (const call of [
    mocks.stop,
    mocks.setPaused,
    mocks.setMuted,
    mocks.setVolume,
    mocks.setFullscreen,
    mocks.seek,
    mocks.scrub,
    mocks.seekBy,
    mocks.setNowPlaying,
  ]) {
    call.mockReset().mockResolvedValue(undefined);
  }
  mocks.systemCaptions.mockReset().mockResolvedValue(false);
  mocks.settings.mockReset().mockResolvedValue(profileSettings());
  mocks.deviceSettings.mockReset().mockResolvedValue(deviceSettings());
  // The playlist, the guide and the stream Go would answer with.
  vi.mocked(LiveTV.Sources).mockImplementation(() =>
    Runtime.CancellablePromise.resolve<Source[] | null>([]),
  );
  vi.mocked(LiveTV.Channels).mockImplementation(() =>
    Runtime.CancellablePromise.resolve<Channel[]>(channels),
  );
  vi.mocked(LiveTV.NowNext).mockImplementation(() =>
    Runtime.CancellablePromise.resolve<NowNext[]>(nowNext),
  );
  vi.mocked(LiveTV.Favourites).mockImplementation(() =>
    Runtime.CancellablePromise.resolve<string[]>([]),
  );
  vi.mocked(LiveTV.Stream).mockImplementation(() => Runtime.CancellablePromise.resolve(live));
});

describe("live player", () => {
  it("shows the LIVE badge, the now programme's title and the channel", async () => {
    await openChannel();

    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Breakfast News" })).toBeInTheDocument();
    expect(screen.getByText("News One")).toBeInTheDocument();
    // The OS's Now Playing says what this screen's heading says.
    await waitFor(() =>
      expect(mocks.setNowPlaying).toHaveBeenCalledWith({
        title: "Breakfast News",
        subtitle: "News One",
      }),
    );
  });

  it("has no seek row for a stream that cannot seek", async () => {
    await openChannel();
    emit("player:state", { ...playing, seekable: false });

    expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  });

  it("shows Go live for a DVR window, and goes to the live edge", async () => {
    await openChannel();
    emit("player:state", playing);

    expect(await screen.findByRole("slider", { name: "Seek" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Go live" }));
    expect(mocks.seek).toHaveBeenLastCalledWith(3600);
  });

  it("moves to the next channel on Page Down, in place", async () => {
    const { router } = await openChannel();
    const before = router.history.length;

    await userEvent.setup().keyboard("{PageDown}");

    await waitFor(() => expect(vi.mocked(LiveTV.Stream)).toHaveBeenCalledWith(1, "src:bbb"));
    // The new channel's stream is loaded, then the history entry replaced.
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(live, expect.anything()));
    await waitFor(() =>
      expect(router.state.location.state.player?.live?.channelId).toBe("src:bbb"),
    );
    expect(router.history.length).toBe(before);
  });

  it("wraps to the last channel on Page Up from the first", async () => {
    await openChannel();

    await userEvent.setup().keyboard("{PageUp}");

    await waitFor(() => expect(vi.mocked(LiveTV.Stream)).toHaveBeenCalledWith(1, "src:ccc"));
  });

  it("moves through the group with the channel buttons", async () => {
    await openChannel("src:bbb");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Previous channel" }));
    await waitFor(() => expect(vi.mocked(LiveTV.Stream)).toHaveBeenLastCalledWith(1, "src:aaa"));

    await user.click(await screen.findByRole("button", { name: "Next channel" }));
    await waitFor(() => expect(vi.mocked(LiveTV.Stream)).toHaveBeenLastCalledWith(1, "src:bbb"));
  });

  it("shows Channel unavailable when the channel stops", async () => {
    await openChannel();
    emit("player:ended", { reason: "error", code: "failed" } satisfies Ended);

    expect(await screen.findByRole("heading", { name: "Channel unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Never the film player's error screen, nor its way out to a stream list.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose another stream" })).toBeNull();
  });

  it("pauses on Space and mutes on M", async () => {
    await openChannel();
    emit("player:state", playing);
    const user = userEvent.setup();

    await user.keyboard(" ");
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);

    await user.keyboard("m");
    expect(mocks.setMuted).toHaveBeenLastCalledWith(true);
  });

  it("has none of the film player's extras", async () => {
    await openChannel();
    emit("player:state", playing);

    for (const name of [
      /Next episode/i,
      /Skip intro/i,
      /Streams/i,
      /Download/i,
      /Watch together/i,
      /Watch party/i,
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("leaves the screen on Back", async () => {
    const { router } = await openChannel();

    await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/library"));
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  });
});
