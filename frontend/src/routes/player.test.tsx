import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";
import type { Ended, State, Track } from "@bindings/player";
import type { Profile, ProfileSettings } from "@bindings/store";
import type { Request, Source } from "@bindings/streams";
import type { Status } from "@bindings/torrent";
import { idleState } from "@/lib/player";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  snapshot: vi.fn<() => Promise<State>>(),
  load: vi.fn<(source: Source, opts: { start: number }) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  setPaused: vi.fn<(paused: boolean) => Promise<void>>(),
  seek: vi.fn<(position: number) => Promise<void>>(),
  scrub: vi.fn<(position: number) => Promise<void>>(),
  setVolume: vi.fn<(volume: number) => Promise<void>>(),
  setMuted: vi.fn<(muted: boolean) => Promise<void>>(),
  setFullscreen: vi.fn<(on: boolean) => Promise<void>>(),
  setAudioTrack: vi.fn<(id: number) => Promise<void>>(),
  setSubtitleTrack: vi.fn<(id: number) => Promise<void>>(),
  setSubtitleDelay: vi.fn<(delay: number) => Promise<void>>(),
  setSubtitleSize: vi.fn<(size: string) => Promise<void>>(),
  saveSettings: vi.fn<(id: number, settings: ProfileSettings) => Promise<void>>(),
  resolve: vi.fn<(request: Request) => Promise<Source>>(),
  torrentStatus: vi.fn<() => Promise<Status>>(),
  release: vi.fn<() => Promise<void>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        mocks.handlers.set(name, callback);
        return () => mocks.handlers.delete(name);
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
    Seek: mocks.seek,
    Scrub: mocks.scrub,
    SetVolume: mocks.setVolume,
    SetMuted: mocks.setMuted,
    SetFullscreen: mocks.setFullscreen,
    SetAudioTrack: mocks.setAudioTrack,
    SetSubtitleTrack: mocks.setSubtitleTrack,
    SetSubtitleDelay: mocks.setSubtitleDelay,
    SetSubtitleSize: mocks.setSubtitleSize,
  },
}));

vi.mock("@bindings/streams", () => ({ Service: { Resolve: mocks.resolve } }));
vi.mock("@bindings/torrent", () => ({
  Service: { Status: mocks.torrentStatus, Release: mocks.release },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    ProfileSettings: () => Promise.resolve(japanese),
    SaveProfileSettings: mocks.saveSettings,
  },
}));

// Japanese audio with English captions, large.
const japanese: ProfileSettings = {
  audioLanguage: "ja",
  subtitleLanguage: "en",
  subtitleSize: "large",
  captions: "on",
};
const profileOptions = { ...japanese, start: 600 };

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
  userAgent: "Sinag/test",
  contentType: "video/x-matroska",
  size: 1,
};

const emit = (name: string, data: unknown) =>
  act(() => {
    mocks.handlers.get(name)?.({ data });
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

async function openPlayer(episode?: string, played = source) {
  const app = await renderApp("/library", { shell: false });
  await act(() =>
    app.router.navigate({
      to: "/player",
      state: (state) => ({ ...state, player: { title: "The Film", episode, source: played } }),
    }),
  );
  await screen.findByRole("heading", { name: "The Film" });
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  mocks.handlers.clear();
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
    mocks.setAudioTrack,
    mocks.setSubtitleTrack,
    mocks.setSubtitleDelay,
    mocks.setSubtitleSize,
    mocks.saveSettings,
  ]) {
    call.mockReset().mockResolvedValue(undefined);
  }
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Sinag can’t play this file");
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("shows the title, the episode and the time", async () => {
    await openPlayer("S1 · E2 · Cat’s in the Bag");
    expect(screen.getByText("S1 · E2 · Cat’s in the Bag")).toBeInTheDocument();
    emit("player:state", playing);
    expect(await screen.findByText("10:00 / 2:00:00")).toBeInTheDocument();
    emit("player:time", { position: 601, duration: 7200, buffered: 30 });
    expect(await screen.findByText("10:01 / 2:00:00")).toBeInTheDocument();
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
    expect(screen.getByText("10:10 / 2:00:00")).toBeInTheDocument();
    // A time event from before the seek doesn't take it back.
    emit("player:time", { position: 600.2, duration: 7200, buffered: 0 });
    expect(screen.getByText("10:10 / 2:00:00")).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Full screen" }));
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
    emit("player:state", { ...playing, fullscreen: true });
    // Esc leaves fullscreen first, not the player.
    await user.keyboard("{Escape}");
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();
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

  it("picks audio and subtitles from their menus", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Audio" }));
    const audio = await screen.findByRole("menu");
    expect(
      within(audio).getByRole("menuitemradio", { name: "English AAC · Stereo" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      within(audio).getByRole("menuitemradio", { name: "Japanese Commentary · AC3 · 5.1" }),
    );
    expect(mocks.setAudioTrack).toHaveBeenLastCalledWith(2);
    // Shown at once, before the player says so.
    expect(within(audio).getByRole("menuitemradio", { name: /^Japanese/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    // Esc closed the menu, not the player.
    expect(screen.getByRole("heading", { name: "The Film" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Subtitles" }));
    const subtitles = await screen.findByRole("menu");
    expect(within(subtitles).getByRole("menuitemradio", { name: "Off" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      within(subtitles).getByRole("menuitemradio", { name: "English Signs · Forced" }),
    ).toBeInTheDocument();
    await user.click(within(subtitles).getByRole("menuitemradio", { name: "English SDH" }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(4);
    await user.click(within(subtitles).getByRole("menuitemradio", { name: "Off" }));
    expect(mocks.setSubtitleTrack).toHaveBeenLastCalledWith(0);
  });

  it("has no audio menu for one track, nor a subtitles menu for none", async () => {
    await openPlayer();
    emit("player:state", { ...playing, tracks: [english] });
    await screen.findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subtitles" })).not.toBeInTheDocument();
  });

  it("sizes subtitles and keeps the size as the profile's", async () => {
    await openPlayer();
    emit("player:state", withTracks);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Subtitles" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Medium" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(menu).getByRole("menuitemradio", { name: "Small" }));
    expect(mocks.setSubtitleSize).toHaveBeenLastCalledWith("small");
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenLastCalledWith(1, {
        ...japanese,
        subtitleSize: "small",
      }),
    );
  });

  it("times subtitles with Z and X, and from the menu", async () => {
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
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Timing: 0.1 s earlier")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Later" }));
    await waitFor(() => expect(mocks.setSubtitleDelay).toHaveBeenLastCalledWith(0));
    // The menu stays open for more steps.
    expect(within(menu).getByText("Timing: On time")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reset timing" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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
      audioLanguage: "eng",
      subtitleLanguage: "eng",
      captions: "on",
    });
  });
});

const track = (fields: Partial<Track> & Pick<Track, "id" | "type">): Track => ({
  title: "",
  lang: "",
  codec: "",
  default: false,
  selected: false,
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
