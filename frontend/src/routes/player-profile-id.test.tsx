import { act, configure, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";
import type { State } from "@bindings/player";
import type { Profile } from "@bindings/store";
import { idleState } from "@/lib/player";
import { profileSettings } from "@/test/fixtures";
import { onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// The player asked the store about profile 0 (#158): a bound call made before
// CurrentProfile had answered — a launch, or a webview reload after WebKit
// killed the page, restored onto /player — went out with the zero-value id,
// and Go refused it every session: "store: profile not found: 0". The page
// now waits for a profile the store has (lib/profile's profileKnown), and
// asks about the real one as soon as it arrives.

configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { data: unknown }) => void>>(),
  snapshot: vi.fn<() => Promise<State>>(),
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
    Load: () => Promise.resolve(),
    Stop: () => Promise.resolve(),
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
    AddSubtitle: () => Promise.resolve(1),
    SubtitleSync: () => Promise.resolve({ status: "", firstShift: 0, lastShift: 0 }),
    SystemCaptions: () => Promise.resolve(false),
    Brightness: () => Promise.resolve(0.5),
    SetBrightness: () => Promise.resolve(),
    SystemVolume: () => Promise.resolve(0.5),
    SetSystemVolume: () => Promise.resolve(),
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

vi.mock("@bindings/streams", () => ({ Service: { Resolve: () => Promise.resolve(null) } }));
vi.mock("@bindings/torrent", () => ({
  Service: { Status: () => Promise.resolve({ active: false }), Release: () => Promise.resolve() },
}));
vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => Promise.resolve([]),
    Refresh: () => Promise.resolve(0),
    Streams: () => Promise.resolve([]),
  },
}));
vi.mock("@bindings/markers", () => ({ Service: { Segments: () => Promise.resolve([]) } }));
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));
vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));
vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.resolve(),
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

// Every call the store gets, in order, with its arguments.
const calls: { method: string; args: readonly unknown[] }[] = [];

// What Go answers a call about profile 0: "store: profile not found: 0".
const refuse = () => Promise.reject(new Error("store: profile not found: 0"));

// A store method that records its call, and refuses one about profile 0 the
// way Go does, so a screen asking about a profile that isn't there fails
// here as it does on the device.
function storeCall<A extends unknown[], R>(method: string, answer: (...args: A) => Promise<R>) {
  return (...args: A): Promise<R> => {
    calls.push({ method, args });
    return args.includes(0) ? refuse() : answer(...args);
  };
}

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;
const settings = profileSettings({});
const device = {
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
  subtitles: { always: false, style: settings.subtitleStyle },
};

// The store's CurrentProfile: answered by the test, so the player can be seen
// mounted before it has a profile.
let currentProfile: () => Promise<Profile | undefined> = () => Promise.resolve(kevin);

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: storeCall("Profiles", () => Promise.resolve([kevin])),
    CurrentProfile: (): Promise<Profile | undefined> => currentProfile(),
    ProfileSettings: storeCall("ProfileSettings", () => Promise.resolve(settings)),
    SaveProfileSettings: storeCall("SaveProfileSettings", () => Promise.resolve()),
    DeviceSettings: storeCall("DeviceSettings", () => Promise.resolve(device)),
    SaveDeviceSettings: storeCall("SaveDeviceSettings", () => Promise.resolve()),
    Addons: storeCall("Addons", () => Promise.resolve([])),
    VisibleAddons: storeCall("VisibleAddons", () => Promise.resolve([])),
    TitleProgress: storeCall("TitleProgress", () => Promise.resolve([])),
    TitleWatched: storeCall("TitleWatched", () => Promise.resolve([])),
    Watched: storeCall("Watched", () => Promise.resolve([])),
    Library: storeCall("Library", () => Promise.resolve([])),
    ContinueWatching: storeCall("ContinueWatching", () => Promise.resolve([])),
    LastWatched: storeCall("LastWatched", () => Promise.resolve({})),
    RecentSearches: storeCall("RecentSearches", () => Promise.resolve([])),
    HomeLayout: storeCall("HomeLayout", () => Promise.resolve(null)),
    Collections: storeCall("Collections", () => Promise.resolve([])),
    ChosenSource: storeCall("ChosenSource", () => Promise.resolve(null)),
    SetChosenSource: storeCall("SetChosenSource", () => Promise.resolve()),
    TitleAdjustments: storeCall("TitleAdjustments", () => Promise.resolve(null)),
    AdjustedTitles: storeCall("AdjustedTitles", () => Promise.resolve([])),
    SetTitleAdjustments: storeCall("SetTitleAdjustments", () => Promise.resolve()),
    SeedAudioLanguages: storeCall("SeedAudioLanguages", () => Promise.resolve(false)),
  },
}));

const source = {
  url: "https://cdn.example/film.mkv",
  origin: "https://torrentio.strem.fun/resolve/torbox/KEY/abc/null/0/film.mkv",
  headers: {},
  userAgent: "Peli/test",
  contentType: "video/x-matroska",
  size: 1,
};

beforeEach(() => {
  calls.length = 0;
  mocks.handlers.clear();
  mocks.snapshot.mockReset().mockResolvedValue({ ...idleState, active: true, loading: true });
  currentProfile = () => Promise.resolve(kevin);
});

afterEach(() => {
  vi.useRealTimers();
});

// What the store was asked about a profile that isn't there.
const aboutZero = () =>
  calls
    .filter((call) => call.args.includes(0))
    .map((call) => `${call.method}(${String(call.args[0])})`);

const asked = (method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.args[0]);

async function playBeforeTheProfileAnswers() {
  let answer!: (profile: Profile) => void;
  const pending = new Promise<Profile>((resolve) => {
    answer = resolve;
  });
  currentProfile = () => pending;

  const app = await renderApp("/library", { shell: false });
  await act(() =>
    app.router.navigate({
      to: "/player",
      state: (state) => ({
        ...state,
        player: {
          title: "The Film",
          source,
          watching: {
            profileId: 1,
            contentId: "tt0000001",
            contentType: "movie",
            videoId: "tt0000001",
            title: "The Film",
          },
        },
      }),
    }),
  );
  await screen.findByRole("heading", { name: "The Film" });
  return { app, answerProfile: () => answer(kevin), pending };
}

describe("the player with the profile still unknown", () => {
  it("asks the store nothing about profile 0, then about the profile it has", async () => {
    const { app, answerProfile, pending } = await playBeforeTheProfileAnswers();

    // Mounted, playing, and no id yet: nothing is asked about 0.
    expect(aboutZero()).toEqual([]);

    await act(async () => {
      answerProfile();
      await pending;
    });

    // The profile's own things are asked for as soon as it lands.
    await waitFor(() => expect(asked("Addons")).toEqual([1]));
    expect(asked("VisibleAddons")).toEqual([1]);
    expect(asked("ProfileSettings")).toEqual([1]);
    expect(aboutZero()).toEqual([]);

    // Leaving ends the session; the screens behind ask about the profile they
    // have, never about 0.
    await act(() => app.router.navigate({ to: "/library" }));
    expect(aboutZero()).toEqual([]);
  });

  it("asks nothing about 0 leaving again before the profile has answered", async () => {
    const { app } = await playBeforeTheProfileAnswers();
    expect(aboutZero()).toEqual([]);

    // Closing the player ends the session and refreshes what's behind it,
    // with no profile in hand: still nothing asked about 0.
    await act(() => app.router.navigate({ to: "/library" }));
    await act(() => Promise.resolve());
    expect(aboutZero()).toEqual([]);
  });

  it("asks nothing about 0 on the iOS player either, touch chrome and all", async () => {
    onIOS();
    const { app, answerProfile, pending } = await playBeforeTheProfileAnswers();
    expect(aboutZero()).toEqual([]);

    await act(async () => {
      answerProfile();
      await pending;
    });
    await waitFor(() => expect(asked("Addons")).toEqual([1]));
    expect(aboutZero()).toEqual([]);

    await act(() => app.router.navigate({ to: "/library" }));
    expect(aboutZero()).toEqual([]);
  });
});
