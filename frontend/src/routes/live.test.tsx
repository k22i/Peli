import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CancellablePromise } from "@wailsio/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Source as Playable } from "@bindings/streams";
import type { Profile } from "@bindings/store";
import { LiveTV, type Channel, type NowNext, type Programme, type Source } from "@/lib/livetv";
import { idleState, Player } from "@/lib/player";
import { deviceSettings, profileSettings } from "@/test/fixtures";
import { renderApp } from "@/test/render-app";

// Live TV (ADR-0066): the /live page's channel list — its groups as chips,
// the filter field, favourites, playing a channel — and where a profile with
// no playlist, or a kids profile, is sent instead. The guide is another
// worker's and is stubbed to say what the page handed it.

// Which profile is in use: the page sends a kids profile home.
const backend = vi.hoisted(() => ({ kids: false }));

function profile(): Profile {
  return {
    id: 1,
    name: backend.kids ? "Kids" : "Kevin",
    nuvioIndex: 1,
    kids: backend.kids,
  };
}

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([profile()]),
    CurrentProfile: () => Promise.resolve(profile()),
    Addons: () => Promise.resolve([]),
    VisibleAddons: () => Promise.resolve([]),
    ProfileSettings: () => Promise.resolve(profileSettings()),
    DeviceSettings: () => Promise.resolve(deviceSettings()),
    // Home is where a kids profile lands: it asks these as it renders.
    Library: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
  },
}));

// No TMDB key: the title-page prefetch in the shell asks the keychain.
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: () => Promise.resolve("offline"),
    CheckConnection: () => Promise.resolve("offline"),
  },
}));

// Playing a channel loads the stream with no Watching: nothing here needs
// mpv, only the calls lib/livetv makes on its way to the player.
vi.mock("@bindings/player", () => ({
  Service: {
    Load: vi.fn(() => Promise.resolve()),
    Snapshot: vi.fn(() => Promise.resolve(idleState)),
    Stop: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@/components/livetv/guide-grid", () => ({
  GuideGrid: ({ channels }: { channels: readonly unknown[] }) => (
    <p>Guide with {channels.length} channels</p>
  ),
}));

const minute = 60_000;

const source: Source = {
  id: "src1",
  profileId: 1,
  name: "Home playlist",
  createdAt: 1,
  updatedAt: 1,
  hasGuide: true,
  guideFromPlaylist: false,
  channels: 5,
  guideChannels: 5,
  programmes: 8,
  playlistAt: 1,
  guideAt: 1,
  playlistError: "",
  guideError: "",
  refreshing: false,
};

const channel = (id: string, number: number, name: string, group: string): Channel => ({
  id,
  sourceId: source.id,
  number,
  name,
  logo: "",
  group,
  tvgId: "",
  tvgName: "",
});

const newsOne = channel("src1:1", 1, "News One", "News");
const newsTwo = channel("src1:2", 2, "News Two", "News");
const filmOne = channel("src1:3", 3, "Film One", "Movies");
const filmTwo = channel("src1:4", 4, "Film Two", "Movies");
// A playlist entry with no group-title: the "Other" chip.
const local = channel("src1:5", 5, "Local Access", "");

const channels = [newsOne, newsTwo, filmOne, filmTwo, local];

// What started half an hour ago and ends half an hour from now, so its
// progress bar reads half way.
const startedAt = Date.now() - 30 * minute;

const programme = (channelId: string, start: number, title: string): Programme => ({
  channelId,
  start,
  stop: start + 60 * minute,
  title,
  subTitle: "",
  description: "",
  categories: [],
  episode: "",
  icon: "",
});

// The guide's answer: what is on and next. Film Two's has not begun, so it
// has a next and no now.
const schedule: NowNext[] = [
  {
    channelId: newsOne.id,
    now: programme(newsOne.id, startedAt, "Midnight News"),
    next: programme(newsOne.id, startedAt + 60 * minute, "World Report"),
  },
  {
    channelId: filmTwo.id,
    now: null,
    next: programme(filmTwo.id, startedAt, "Late Film"),
  },
];

const playable: Playable = {
  url: "https://iptv.example/KEY/news-two.ts",
  origin: `livetv:${newsTwo.id}`,
  headers: {},
  userAgent: "Peli/test",
  contentType: "video/mp2t",
  size: 0,
};

// What Go answers for one test. Stream is left refusing, as a channel nobody
// added would.
function livetv({
  sources = [],
  list = [],
  nowNext = [],
  favourites = [],
  stream,
}: {
  sources?: Source[];
  list?: Channel[];
  nowNext?: NowNext[];
  favourites?: string[];
  stream?: Playable;
}) {
  vi.mocked(LiveTV.Sources).mockImplementation(() =>
    CancellablePromise.resolve<Source[] | null>(sources),
  );
  vi.mocked(LiveTV.Channels).mockImplementation(() =>
    CancellablePromise.resolve<Channel[] | null>(list),
  );
  vi.mocked(LiveTV.NowNext).mockImplementation(() =>
    CancellablePromise.resolve<NowNext[] | null>(nowNext),
  );
  vi.mocked(LiveTV.Favourites).mockImplementation(() =>
    CancellablePromise.resolve<string[] | null>(favourites),
  );
  if (stream) {
    vi.mocked(LiveTV.Stream).mockImplementation(() => CancellablePromise.resolve(stream));
  }
}

const rail = () => screen.findByRole("group", { name: "Group" });

beforeEach(() => {
  backend.kids = false;
  // Offline: nothing on the page needs the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("offline"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live page", () => {
  it("lists every channel under its group, with what is on now and next", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule });
    await renderApp("/live");

    expect(await screen.findByRole("heading", { level: 1, name: "Live TV" })).toBeInTheDocument();
    // The playlist's groups in the order they appear, "Other" (no group) last.
    expect(
      within(await rail())
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["All", "News", "Movies", "Other"]);

    for (const name of ["News One", "News Two", "Film One", "Film Two", "Local Access"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    }

    expect(screen.getByText("Midnight News")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Midnight News, 50% watched" });
    expect(Number(bar.getAttribute("value"))).toBeCloseTo(0.5, 2);
    expect(screen.getByText(/^Next · .*World Report$/)).toBeInTheDocument();
  });

  it("shows one group, and keeps it in the address", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule });
    const { router } = await renderApp("/live");
    const user = userEvent.setup();

    await user.click(within(await rail()).getByRole("button", { name: "News" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ group: "News" }));
    expect(screen.getByRole("button", { name: "News One" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Film One" })).not.toBeInTheDocument(),
    );
  });

  it("narrows the list by name, whatever the case", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule });
    await renderApp("/live");
    const user = userEvent.setup();

    await user.type(await screen.findByRole("searchbox", { name: "Filter channels" }), "NEWS");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Film One" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "News One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "News Two" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Local Access" })).not.toBeInTheDocument();
  });

  it("keeps the favourites on a chip of their own, and stars them", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule, favourites: [filmOne.id] });
    vi.mocked(LiveTV.SetFavourite).mockImplementation(() =>
      CancellablePromise.resolve<string[] | null>([filmOne.id, newsOne.id]),
    );
    await renderApp("/live");
    const user = userEvent.setup();

    await user.click(within(await rail()).getByRole("button", { name: "Favourites" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "News One" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Film One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Film One from favourites" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Back to every channel to star another.
    await user.click(within(await rail()).getByRole("button", { name: "All" }));
    await user.click(await screen.findByRole("button", { name: "Add News One to favourites" }));

    expect(vi.mocked(LiveTV.SetFavourite)).toHaveBeenCalledWith(1, newsOne.id, true);
  });

  it("plays a channel and opens the live player on it", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule, stream: playable });
    const { router } = await renderApp("/live");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "News Two" }));

    await waitFor(() => expect(vi.mocked(LiveTV.Stream)).toHaveBeenCalledWith(1, newsTwo.id));
    expect(vi.mocked(Player.Load)).toHaveBeenCalled();
    await waitFor(() =>
      expect(router.state.location.state.player?.live).toEqual({
        channelId: newsTwo.id,
        group: "",
      }),
    );
    expect(router.state.location.pathname).toBe("/player");
  });

  it("says a channel is unavailable when its stream fails", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule });
    await renderApp("/live");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Film One" }));

    expect(await screen.findByText("Channel unavailable")).toBeInTheDocument();
  });

  it("hands the guide the same list", async () => {
    livetv({ sources: [source], list: channels, nowNext: schedule });
    await renderApp("/live?view=guide");

    expect(await screen.findByText("Guide with 5 channels")).toBeInTheDocument();
    const tabs = await screen.findByRole("tablist", { name: "View" });
    expect(within(tabs).getByRole("tab", { name: "Guide" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("sends a profile with no playlist to Settings", async () => {
    await renderApp("/live");

    expect(await screen.findByRole("heading", { name: "No Live TV yet" })).toBeInTheDocument();
    expect(screen.getByText("Add an M3U playlist in Settings › Live TV.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute(
      "href",
      "/settings?section=livetv",
    );
  });

  it("keeps Live TV from a kids profile", async () => {
    backend.kids = true;
    const { router } = await renderApp("/live");

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("heading", { name: "Live TV" })).not.toBeInTheDocument();
  });
});
