import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import { Service as Downloads } from "@bindings/downloads";
import type { Download } from "@bindings/store";
import type { PlayTarget } from "@/lib/playback";

import { DownloadTrayList, overallPercent, trayDownloads } from "./tray-list";

// The downloads tray's list (#85 follow-up): the day's downloads, how far
// along they are, and what each state can do — pausing, resuming, cancelling
// and playing, which goes through usePlay so a downloaded copy is found.

const mocks = vi.hoisted(() => ({ play: vi.fn<(target: PlayTarget) => void>() }));

// The tray's Play is the shell's: it builds a play target and usePlay takes it
// from there, so the target is what a test reads.
vi.mock("@/lib/playback", () => ({ usePlay: () => mocks.play }));

// The tray opens titles with useOpenTitle (lib/title), which only navigates:
// nothing here asks the store for anything.
vi.mock("@/bindings/store", () => ({ Service: {} }));

// What a mocked binding call answers: a CancellablePromise, which carries a
// cancel() that payloads made by hand don't.
function answering<T>(value: T) {
  return CancellablePromise.resolve(value);
}

function listed(downloads: Download[]) {
  vi.mocked(Downloads.List).mockImplementation(() => answering<Download[] | null>(downloads));
}

// A minute ago, in the epoch the tray's 24 h window is measured in.
const justNow = Date.now() - 60_000;
const hour = 60 * 60 * 1000;

// A record as Go's store keeps it: a finished episode unless a test says
// otherwise.
const download = (changes: Partial<Download> = {}): Download => ({
  id: "a1",
  profileId: 1,
  contentId: "tt0903747",
  contentType: "series",
  videoId: "tt0903747:1:2",
  season: 1,
  episode: 2,
  name: "Breaking Bad",
  episodeName: "Grilled",
  poster: "https://example.test/breaking-bad.jpg",
  metaAddon: "https://addon.example/manifest.json",
  streamSource: "https://addon.example/manifest.json",
  streamName: "TorBox 1080p",
  streamDescription: "Breaking.Bad.S01E02.1080p.mkv",
  resolution: "1080p",
  request: { url: "https://cdn.example/file.mkv", headers: null },
  root: "",
  file: "a1/video.mkv",
  mimeType: "video/x-matroska",
  subtitles: null,
  segments: null,
  state: "done",
  reason: "",
  bytes: 1_400_000_000,
  total: 1_400_000_000,
  createdAt: 1,
  updatedAt: justNow,
  doneAt: justNow,
  ...changes,
});

// A film: the same record with no season, so its label — and its Play — is
// its name alone.
const film = (changes: Partial<Download> = {}): Download =>
  download({ contentType: "movie", season: 0, episode: 0, episodeName: "", ...changes });

// A film on its way: 42 % of 2.9 GB.
const downloading = download({
  id: "b1",
  contentId: "tt0113277",
  contentType: "movie",
  videoId: "tt0113277",
  season: 0,
  episode: 0,
  name: "Heat",
  episodeName: "",
  state: "downloading",
  bytes: 1_218_000_000,
  total: 2_900_000_000,
  doneAt: 0,
});

const paused = download({
  id: "b2",
  contentId: "tt0078748",
  contentType: "movie",
  videoId: "tt0078748",
  season: 0,
  episode: 0,
  name: "Alien",
  episodeName: "",
  state: "paused",
  bytes: 500_000_000,
  total: 2_100_000_000,
  doneAt: 0,
});

const failed = download({
  id: "b3",
  contentId: "tt0112641",
  contentType: "movie",
  videoId: "tt0112641",
  season: 0,
  episode: 0,
  name: "Casino",
  episodeName: "",
  state: "failed",
  reason: "expired",
  bytes: 200_000_000,
  total: 3_000_000_000,
  doneAt: 0,
});

// Renders the tray at the router's root, with the Library and a title page
// behind it: the two places its links and rows go.
function renderTray(touch = false) {
  const onNavigate = vi.fn<() => void>();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const trayRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DownloadTrayList profileId={1} touch={touch} onNavigate={onNavigate} />,
  });
  const libraryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/library",
    component: () => <p>Library</p>,
  });
  const titleRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/title/$type/$id",
    component: () => <p>Title</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([trayRoute, libraryRoute, titleRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { onNavigate, router };
}

beforeEach(() => {
  mocks.play.mockReset();
  vi.mocked(Downloads.Delete).mockClear();
  vi.mocked(Downloads.Pause).mockClear();
  vi.mocked(Downloads.Resume).mockClear();
  listed([]);
});

describe("trayDownloads", () => {
  it("puts what hasn't finished above what has, and the newest of those first", () => {
    const now = 1_800_000_000_000;
    const recent = download({ id: "recent", doneAt: now - 2 * hour, updatedAt: now - 2 * hour });
    const newest = download({ id: "newest", doneAt: now - 60_000, updatedAt: now - 60_000 });
    const active = download({ id: "active", state: "downloading", doneAt: 0 });
    const held = download({ id: "held", state: "paused", doneAt: 0 });

    // The queue as Go runs it, then today's finished, newest first.
    expect(trayDownloads([recent, held, newest, active], now).map((each) => each.id)).toEqual([
      "held",
      "active",
      "newest",
      "recent",
    ]);
  });

  it("leaves out what finished more than a day ago", () => {
    const now = 1_800_000_000_000;
    const yesterday = download({
      id: "yesterday",
      doneAt: now - 23 * hour,
      updatedAt: now - 23 * hour,
    });
    const old = download({ id: "old", doneAt: now - 25 * hour, updatedAt: now - 25 * hour });

    expect(trayDownloads([old, yesterday], now).map((each) => each.id)).toEqual(["yesterday"]);
  });

  it("measures a download with no doneAt from when it last changed", () => {
    const now = 1_800_000_000_000;
    const stamped = download({ id: "stamped", doneAt: 0, updatedAt: now - hour });
    const stale = download({ id: "stale", doneAt: 0, updatedAt: now - 30 * hour });

    expect(trayDownloads([stamped, stale], now).map((each) => each.id)).toEqual(["stamped"]);
  });

  it("keeps one that finished exactly a day ago", () => {
    const now = 1_800_000_000_000;
    const today = download({ doneAt: now - 24 * hour, updatedAt: now - 24 * hour });

    expect(trayDownloads([today], now)).toHaveLength(1);
    expect(trayDownloads([], now)).toEqual([]);
  });
});

describe("overallPercent", () => {
  it("is the share of the totals that are known", () => {
    // 1.218 GB + 500 MB of 2.9 GB + 2.1 GB.
    expect(overallPercent([downloading, paused])).toBe(34);
  });

  it("is undefined when nothing unfinished knows its size", () => {
    expect(overallPercent([])).toBeUndefined();
    expect(overallPercent([download()])).toBeUndefined();
    expect(
      overallPercent([download({ id: "queued", state: "queued", bytes: 0, total: 0 })]),
    ).toBeUndefined();
  });

  it("leaves out an unfinished download with no total yet", () => {
    const queued = download({ id: "queued", state: "queued", bytes: 0, total: 0 });
    expect(overallPercent([downloading, queued])).toBe(42);
  });
});

describe("the tray's list", () => {
  it("says how it is going, and how far along each one is", async () => {
    listed([downloading, paused, download()]);
    renderTray();

    expect(await screen.findByText("2 downloading · 1.7 GB of 5.0 GB")).toBeInTheDocument();
    // "42 % · 1.2 GB of 2.9 GB", with no speed until an event reports one.
    expect(await screen.findByText("42 % · 1.2 GB of 2.9 GB")).toBeInTheDocument();
    // A real <progress>: 42 of 100, named for the row it belongs to.
    expect(screen.getByRole("progressbar", { name: "Heat progress" })).toHaveProperty("value", 42);
    // The finished one's size alone.
    expect(screen.getByText("1.4 GB")).toBeInTheDocument();
  });

  it("says All done once nothing is unfinished", async () => {
    listed([download()]);
    renderTray();

    expect(await screen.findByText("All done")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers Resume to a paused download and Retry to a failed one", async () => {
    listed([paused, failed]);
    renderTray();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resume Alien" }));
    await waitFor(() => expect(vi.mocked(Downloads.Resume)).toHaveBeenCalledWith(1, paused.id));

    await user.click(screen.getByRole("button", { name: "Retry Casino" }));
    await waitFor(() => expect(vi.mocked(Downloads.Resume)).toHaveBeenCalledWith(1, failed.id));
  });

  it("pauses a running download", async () => {
    listed([downloading]);
    renderTray();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Pause Heat" }));
    await waitFor(() => expect(vi.mocked(Downloads.Pause)).toHaveBeenCalledWith(1, downloading.id));
  });

  it("cancels an unfinished download at once, without asking", async () => {
    listed([downloading]);
    renderTray();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel Heat" }));

    await waitFor(() => expect(vi.mocked(Downloads.Delete)).toHaveBeenCalledWith(1, ["b1"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("plays a finished download, closing the tray first", async () => {
    listed([download()]);
    const { onNavigate } = renderTray();
    const order: string[] = [];
    onNavigate.mockImplementation(() => {
      order.push("navigate");
    });
    mocks.play.mockImplementation(() => {
      order.push("play");
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Play Breaking Bad · S1 E2" }));

    expect(mocks.play).toHaveBeenCalledWith({
      type: "series",
      id: "tt0903747",
      title: "Breaking Bad",
      videoId: "tt0903747:1:2",
    });
    // The tray is gone before the video is asked for.
    expect(order).toEqual(["navigate", "play"]);
  });

  it("opens the title page from a row's name, without playing", async () => {
    listed([download()]);
    const { onNavigate, router } = renderTray();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open Breaking Bad · S1 E2" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/title/series/tt0903747"));
    expect(mocks.play).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalled();
  });

  it("goes to the Library's downloads from See all and from a finished row", async () => {
    listed([download()]);
    const { onNavigate } = renderTray();

    const seeAll = await screen.findByRole("link", { name: "See all" });
    expect(seeAll).toHaveAttribute("href", "/library?view=downloads");
    // The header's link is there while the list is still on its way, so the
    // row's own has to be waited for.
    expect(await screen.findByRole("link", { name: "Show in Library" })).toHaveAttribute(
      "href",
      "/library?view=downloads",
    );

    const user = userEvent.setup();
    await user.click(seeAll);
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });

  it("says there is nothing downloaded", async () => {
    listed([]);
    renderTray();

    expect(await screen.findByText("No downloads")).toBeInTheDocument();
    expect(
      screen.getByText("Download a film or an episode from its page or a stream’s menu."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all" })).toBeInTheDocument();
  });

  it("lists only today's finished downloads, the newest first", async () => {
    const longAgo = Date.now() - 30 * hour;
    listed([
      film({ id: "old", name: "Old Film", doneAt: longAgo, updatedAt: longAgo }),
      film({ id: "new", name: "New Film", doneAt: justNow, updatedAt: justNow }),
    ]);
    renderTray();

    const plays = await screen.findAllByRole("button", { name: /^Play / });
    expect(plays.map((button) => button.getAttribute("aria-label"))).toEqual(["Play New Film"]);
  });
});
