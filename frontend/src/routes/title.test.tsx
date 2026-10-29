import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile, Progress, WatchedItem } from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import kitsuAnime from "@/lib/addon-protocol/fixtures/kitsu/meta-anime.json";
import { renderApp } from "@/test/render-app";

// The store, kept in memory so marks and the library change as Go's would.
const db = vi.hoisted(() => ({
  watched: [] as WatchedItem[],
  progress: [] as Progress[],
  library: [] as LibraryItem[],
}));

const sameItem = (a: { season?: number | null; episode?: number | null }, b: typeof a) =>
  (a.season ?? null) === (b.season ?? null) && (a.episode ?? null) === (b.episode ?? null);

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  setWatched: vi.fn<(id: number, items: WatchedItem[], watched: boolean) => Promise<void>>(),
  saveLibraryItem: vi.fn<(id: number, item: LibraryItem) => Promise<void>>(),
  removeLibraryItem: vi.fn<(id: number, contentId: string, type: string) => Promise<void>>(),
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
    Library: () => Promise.resolve([...db.library]),
    TitleWatched: (_: number, id: string) =>
      Promise.resolve(db.watched.filter((item) => item.contentId === id)),
    TitleProgress: (_: number, id: string) =>
      Promise.resolve(db.progress.filter((entry) => entry.contentId === id)),
    SetWatched: mocks.setWatched,
    SaveLibraryItem: mocks.saveLibraryItem,
    RemoveLibraryItem: mocks.removeLibraryItem,
  },
}));

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
const kitsu: Addon = {
  url: "https://anime-kitsu.strem.fun/manifest.json",
  name: "Anime Kitsu",
  enabled: true,
};
// Another meta addon for IMDb ids, first in the user's order.
const mirror: Addon = {
  url: "https://mirror.example/manifest.json",
  name: "Mirror",
  enabled: true,
};
const mirrorManifest = {
  id: "example.mirror",
  name: "Mirror",
  version: "1.0.0",
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  resources: ["meta"],
  catalogs: [],
};

const base = "https://v3-cinemeta.strem.io";
const moviePath = "/title/movie/tt0111161";
const seriesPath = "/title/series/tt0903747";

// Answers addon requests by full URL: a body, or a promise of one for an
// addon that answers when the test says. Anything else answers 503.
function serve(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [kitsu.url]: kitsuManifest,
    [mirror.url]: mirrorManifest,
    [`${base}/meta/movie/tt0111161.json`]: cinemetaMovie,
    [`${base}/meta/series/tt0903747.json`]: cinemetaSeries,
    "https://anime-kitsu.strem.fun/meta/series/kitsu%3A46474.json": kitsuAnime,
    ...answers,
  };
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url in all ? Response.json(await all[url]) : new Response("", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => url);
}

function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const mark = (season: number, episode: number): WatchedItem => ({
  contentId: "tt0903747",
  contentType: "series",
  season,
  episode,
  watchedAt: 1,
});
const episodes = () => screen.findByRole("list", { name: "Season 1" });
const episodeNames = async () =>
  (await within(await episodes()).findAllByRole("button", { name: /^S\d/ })).map((button) =>
    button.getAttribute("aria-label"),
  );
// What SetWatched was asked, as "+1x2" (marked) and "-1x2" (unmarked), "+show".
const writes = () =>
  mocks.setWatched.mock.calls.map(([, items, watched]) =>
    items
      .map(
        (item) =>
          `${watched ? "+" : "-"}${item.season == null ? "show" : `${item.season}x${item.episode}`}`,
      )
      .join(" "),
  );

beforeEach(() => {
  db.watched = [];
  db.progress = [];
  db.library = [];
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta, kitsu]);
  mocks.visibleAddons.mockResolvedValue([cinemeta, kitsu]);
  mocks.setWatched.mockImplementation((_, items, watched) => {
    for (const item of items) {
      db.watched = db.watched.filter((w) => w.contentId !== item.contentId || !sameItem(w, item));
      db.progress = db.progress.filter((p) => p.contentId !== item.contentId || !sameItem(p, item));
      if (watched) db.watched.push(item);
    }
    return Promise.resolve();
  });
  mocks.saveLibraryItem.mockImplementation((_, item) => {
    db.library.push(item);
    return Promise.resolve();
  });
  mocks.removeLibraryItem.mockImplementation((_, id) => {
    db.library = db.library.filter((item) => item.contentId !== id);
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("title page", () => {
  it("opens from a card, paints from it, then fills in the details", async () => {
    const meta = later<unknown>();
    serve({
      [`${base}/catalog/movie/top.json`]: {
        metas: [{ id: "tt0111161", type: "movie", name: "The Shawshank Redemption" }],
      },
      [`${base}/meta/movie/tt0111161.json`]: meta.promise,
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/movies");

    await user.click(await screen.findByRole("button", { name: /Shawshank/ }));
    expect(router.state.location.pathname).toBe(moviePath);
    expect(
      await screen.findByRole("heading", { level: 1, name: "The Shawshank Redemption" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();

    meta.resolve(cinemetaMovie);
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("142 min")).toBeInTheDocument();
    expect(screen.getByText("Frank Darabont")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/movies"));
  });

  it("asks the next addon when the first fails, and only visible addons", async () => {
    mocks.addons.mockResolvedValue([mirror, cinemeta]);
    mocks.visibleAddons.mockResolvedValue([mirror, cinemeta]);
    const asked = serve();
    await renderApp(moviePath);

    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(asked().filter((url) => url.includes("/meta/"))).toEqual([
      "https://mirror.example/meta/movie/tt0111161.json",
      `${base}/meta/movie/tt0111161.json`,
    ]);
  });

  it("never asks an addon a kids profile can't see", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.addons.mockResolvedValue([mirror, cinemeta]);
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    const asked = serve();
    await renderApp(moviePath);

    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(asked().some((url) => url.startsWith("https://mirror.example"))).toBe(false);
  });

  it("says when no addon has the title", async () => {
    serve({ [`${base}/meta/movie/tt0111161.json`]: undefined });
    await renderApp(moviePath);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t load this title" }),
    ).toBeInTheDocument();
  });

  it("marks a film watched and saves it to the library", async () => {
    serve();
    const user = userEvent.setup();
    await renderApp(moviePath);

    await user.click(await screen.findByRole("button", { name: "Mark watched" }));
    expect(await screen.findByRole("button", { name: "Watched" })).toBeInTheDocument();
    expect(mocks.setWatched).toHaveBeenCalledWith(
      1,
      [expect.objectContaining({ contentId: "tt0111161", contentType: "movie" })],
      true,
    );

    await user.click(screen.getByRole("button", { name: "Add to library" }));
    expect(await screen.findByRole("button", { name: "In library" })).toBeInTheDocument();
    expect(db.library[0]).toMatchObject({
      contentId: "tt0111161",
      name: "The Shawshank Redemption",
      addonBaseUrl: base,
    });
    await user.click(screen.getByRole("button", { name: "In library" }));
    expect(await screen.findByRole("button", { name: "Add to library" })).toBeInTheDocument();
  });

  it("shows each episode's watched mark and progress, and resumes", async () => {
    db.watched = [mark(1, 1)];
    db.progress = [
      {
        key: "tt0903747_s1e2",
        contentId: "tt0903747",
        contentType: "series",
        videoId: "tt0903747:1:2",
        season: 1,
        episode: 2,
        position: 600,
        duration: 1000,
        lastWatched: 5,
      },
    ];
    serve();
    const user = userEvent.setup();
    await renderApp(seriesPath);

    expect(await screen.findByRole("img", { name: "Breaking Bad" })).toBeInTheDocument();
    expect(await episodeNames()).toEqual([
      "S1 · E1: Pilot, watched",
      "S1 · E2: Cat's in the Bag..., in progress",
      "S1 · E3: ...And the Bag's in the River",
      "S1 · E4: Cancer Man",
    ]);
    await user.click(screen.getByRole("button", { name: "Resume S1 · E2" }));
    expect(await screen.findByText("Can’t play Breaking Bad S1 · E2 yet")).toBeInTheDocument();
  });

  it("marks a season, keeping the series mark in step", async () => {
    serve();
    const user = userEvent.setup();
    await renderApp(seriesPath);

    await user.click(await screen.findByRole("button", { name: "Mark season watched" }));
    expect(
      await screen.findByRole("button", { name: "Mark season unwatched" }),
    ).toBeInTheDocument();
    // Every episode of the only season, then the series itself.
    expect(writes()).toEqual(["+1x1 +1x2 +1x3 +1x4", "+show"]);
    expect(screen.getByRole("button", { name: "Watched" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mark season unwatched" }));
    await waitFor(() => expect(writes().slice(2)).toEqual(["-1x1 -1x2 -1x3 -1x4", "-show"]));
  });

  it("marks one episode, or every one before it, from its menu", async () => {
    serve();
    const user = userEvent.setup();
    await renderApp(seriesPath);

    await user.click(await screen.findByRole("button", { name: "More for S1 · E3" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark watched" }));
    await waitFor(() => expect(writes()).toEqual(["+1x3"]));

    await user.click(screen.getByRole("button", { name: "More for S1 · E4" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark earlier episodes watched" }),
    );
    await waitFor(() => expect(writes()).toEqual(["+1x3", "+1x1 +1x2 +1x3"]));
    expect(await screen.findByRole("button", { name: "Play S1 · E4" })).toBeInTheDocument();
  });

  it("picks a season from the address and keeps it there", async () => {
    const twoSeasons = structuredClone(cinemetaSeries);
    twoSeasons.meta.videos.push({
      ...twoSeasons.meta.videos[0]!,
      id: "tt0903747:2:1",
      name: "Seven Thirty-Seven",
      season: 2,
      number: 1,
      episode: 1,
      released: "2009-03-08T05:00:00.000Z",
    });
    serve({ [`${base}/meta/series/tt0903747.json`]: twoSeasons });
    const user = userEvent.setup();
    const { router } = await renderApp(`${seriesPath}?season=2`);

    expect(await screen.findByRole("list", { name: "Season 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Season 1" }));
    expect(await episodes()).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ season: 1 });
  });

  it("can't play or mark an episode that hasn't aired", async () => {
    const upcoming = structuredClone(cinemetaSeries);
    upcoming.meta.videos[3]!.released = "2999-01-01T00:00:00.000Z";
    serve({ [`${base}/meta/series/tt0903747.json`]: upcoming });
    await renderApp(seriesPath);

    expect(await screen.findByRole("button", { name: "S1 · E4: Cancer Man" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "More for S1 · E4" })).toBeNull();
  });

  it("opens Kitsu's anime from their own addon", async () => {
    const asked = serve();
    await renderApp(`/title/series/${encodeURIComponent("kitsu:46474")}`);

    expect(await screen.findByRole("button", { name: /S1 · E1: The Journey/ })).toBeInTheDocument();
    expect(asked().filter((url) => url.includes("/meta/"))).toEqual([
      "https://anime-kitsu.strem.fun/meta/series/kitsu%3A46474.json",
    ]);
  });
});
