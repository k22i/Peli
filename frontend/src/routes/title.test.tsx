import { act, screen, waitFor, within } from "@testing-library/react";
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

// The keychain, holding a TMDB key when a test saves one.
const keychain = vi.hoisted(() => ({ tmdb: null as string | null }));
vi.mock("@bindings/secrets", () => ({
  Service: { Get: (key: string) => Promise.resolve(key === "tmdb.api-key" ? keychain.tmdb : null) },
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

// The images under a page's artwork, backdrops and cast photos.
const backdrops = () =>
  [...document.querySelectorAll<HTMLImageElement>("[data-slot=artwork] img")].map(
    (image) => image.src,
  );

// The hero is the one labelled <section> a page observes; the Episodes
// header's sentinel is its 1px aria-hidden strip.
const isHero = (target: Element) =>
  target.tagName === "SECTION" && target.hasAttribute("aria-label");
const isSentinel = (target: Element) =>
  target.getAttribute("aria-hidden") === "true" && target.classList.contains("h-px");

// A series with `count` seasons of one episode each.
function seasons(count: number) {
  const series = structuredClone(cinemetaSeries);
  series.meta.videos = Array.from({ length: count }, (_, index) => ({
    ...cinemetaSeries.meta.videos[0]!,
    id: `tt0903747:${index + 1}:1`,
    name: `Episode of season ${index + 1}`,
    season: index + 1,
    number: 1,
    episode: 1,
  }));
  return { [`${base}/meta/series/tt0903747.json`]: series };
}

beforeEach(() => {
  keychain.tmdb = null;
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
    // The rating sits in its own pill, after the meta line (#117).
    expect(screen.getByText("IMDb 9.3")).toBeInTheDocument();
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
    const { router } = await renderApp(seriesPath);

    expect(await screen.findByRole("img", { name: "Breaking Bad" })).toBeInTheDocument();
    expect(await episodeNames()).toEqual([
      "S1 · E1: Pilot, watched",
      "S1 · E2: Cat's in the Bag..., in progress",
      "S1 · E3: ...And the Bag's in the River",
      "S1 · E4: Cancer Man",
    ]);
    await user.click(screen.getByRole("button", { name: "Resume S1 · E2" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Breaking Bad S1 · E2" }),
    ).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ video: "tt0903747:1:2" });
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
    // The air date takes the runtime's place.
    expect(screen.getByText(/^S1 · E4 · Airs /)).toBeInTheDocument();
  });

  it("opens Kitsu's anime from their own addon", async () => {
    const asked = serve();
    await renderApp(`/title/series/${encodeURIComponent("kitsu:46474")}`);

    expect(await screen.findByRole("button", { name: /S1 · E1: The Journey/ })).toBeInTheDocument();
    expect(asked().filter((url) => url.includes("/meta/"))).toEqual([
      "https://anime-kitsu.strem.fun/meta/series/kitsu%3A46474.json",
    ]);
  });
  it("keeps the Library and Watched buttons' names on their round icon buttons", async () => {
    serve();
    await renderApp(moviePath);

    const library = await screen.findByRole("button", { name: "Add to library" });
    const watched = screen.getByRole("button", { name: "Mark watched" });
    // Icon-only: the label is the accessible name and the tooltip's text, not
    // text in the button.
    expect(library.textContent).toBe("");
    expect(watched.textContent).toBe("");
    expect(library).toHaveClass("rounded-full");
    expect(watched).toHaveClass("rounded-full");
  });

  describe("scrolling", () => {
    // jsdom has no IntersectionObserver: record who watches what, and let a
    // test say what they see.
    type Watcher = {
      callback: (entries: { isIntersecting: boolean }[]) => void;
      targets: Element[];
    };
    const watchers: Watcher[] = [];
    const see = (match: (target: Element) => boolean, isIntersecting: boolean) =>
      act(() => {
        for (const { callback, targets } of watchers) {
          if (targets.some(match)) callback([{ isIntersecting }]);
        }
      });

    beforeEach(() => {
      watchers.length = 0;
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          private readonly entry: Watcher;
          constructor(callback: Watcher["callback"]) {
            this.entry = { callback, targets: [] };
            watchers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.targets.push(target);
          }
          disconnect() {}
          unobserve() {}
        },
      );
    });

    it("turns the Back button from media glass to glass once the hero scrolls away", async () => {
      serve();
      await renderApp(moviePath);

      const back = await screen.findByRole("button", { name: "Back" });
      await waitFor(() => expect(back).toHaveAttribute("data-over-hero"));
      expect(back).toHaveClass("glass-media");

      see(isHero, false);
      await waitFor(() => expect(back).not.toHaveAttribute("data-over-hero"));
      expect(back).toHaveClass("glass");
      expect(back).not.toHaveClass("glass-media");

      see(isHero, true);
      await waitFor(() => expect(back).toHaveAttribute("data-over-hero"));
    });

    it("sticks the Episodes header as glass once the list scrolls under it", async () => {
      serve();
      await renderApp(seriesPath);

      const header = (await screen.findByRole("heading", { name: "Episodes" })).closest("header")!;
      expect(header).not.toHaveAttribute("data-stuck");
      see(isSentinel, false);
      await waitFor(() => expect(header).toHaveAttribute("data-stuck"));
      see(isSentinel, true);
      await waitFor(() => expect(header).not.toHaveAttribute("data-stuck"));
    });
  });

  describe("seasons", () => {
    it("lists up to thirty seasons as chips on a rail", async () => {
      serve(seasons(30));
      await renderApp(seriesPath);

      const group = await screen.findByRole("group", { name: "Seasons" });
      expect(within(group).getAllByRole("button")).toHaveLength(30);
      expect(screen.queryByRole("combobox", { name: "Season" })).toBeNull();
    });

    it("puts more than thirty seasons in a menu", async () => {
      serve(seasons(31));
      await renderApp(seriesPath);

      expect(await screen.findByRole("combobox", { name: "Season" })).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Seasons" })).toBeNull();
    });
  });

  describe("with a TMDB key", () => {
    const tmdb = "https://api.themoviedb.org/3";
    const img = "https://image.tmdb.org/t/p";
    const movie = `${tmdb}/movie/278?append_to_response=images%2Ccredits%2Calternative_titles%2Ctranslations&include_image_language=en%2Cnull&api_key=key`;
    const findFrieren = `${tmdb}/find/tt22248376?external_source=imdb_id&api_key=key`;
    const frieren = `${tmdb}/tv/209867?append_to_response=images%2Caggregate_credits%2Calternative_titles%2Ctranslations&include_image_language=en%2Cnull&api_key=key`;
    const shawshank = {
      backdrop_path: "/shawshank.jpg",
      images: { logos: [{ iso_639_1: "en", file_path: "/shawshank-logo.png" }] },
      credits: {
        cast: [
          { id: 504, name: "Tim Robbins", character: "Andy Dufresne", profile_path: "/tim.jpg" },
          { id: 192, name: "Morgan Freeman", character: "Ellis Boyd 'Red' Redding" },
        ],
      },
    };

    beforeEach(() => {
      keychain.tmdb = "key";
    });

    it("shows TMDB's logo, backdrop and cast photos over the addon's", async () => {
      const asked = serve({ [movie]: shawshank });
      await renderApp(moviePath);

      expect(await screen.findByRole("heading", { name: "Cast" })).toBeInTheDocument();
      const cast = screen.getByRole("list", { name: "Cast" });
      expect(within(cast).getByText("Tim Robbins")).toBeInTheDocument();
      expect(within(cast).getByText("Andy Dufresne")).toBeInTheDocument();
      expect(cast.querySelector(`img[src="${img}/w342/tim.jpg"]`)).not.toBeNull();
      expect(screen.getByRole("img", { name: "The Shawshank Redemption" })).toHaveAttribute(
        "src",
        `${img}/w500/shawshank-logo.png`,
      );
      // The addon's backdrop stays under TMDB's until it loads.
      expect(backdrops()).toEqual(
        expect.arrayContaining([`${img}/original/shawshank.jpg`, cinemetaMovie.meta.background]),
      );
      // The IMDb id is looked up beside the addon; Cinemeta's moviedb_id
      // names the same title, so its details are asked once.
      expect(asked().filter((url) => url.startsWith(tmdb))).toEqual([
        `${tmdb}/find/tt0111161?external_source=imdb_id&api_key=key`,
        movie,
      ]);
      // The cast isn't listed twice; the crew still comes from the addon.
      expect(screen.queryByText("Cast", { selector: "dt" })).toBeNull();
      expect(screen.getByText("Frank Darabont")).toBeInTheDocument();
    });

    it("finds a Kitsu anime by its IMDb id", async () => {
      const asked = serve({
        [findFrieren]: { movie_results: [], tv_results: [{ id: 209867 }] },
        [frieren]: {
          aggregate_credits: {
            cast: [{ id: 1, name: "Atsumi Tanezaki", roles: [{ character: "Frieren" }] }],
          },
        },
      });
      await renderApp(`/title/series/${encodeURIComponent("kitsu:46474")}`);

      expect(await screen.findByText("Atsumi Tanezaki")).toBeInTheDocument();
      expect(screen.getByText("Frieren")).toBeInTheDocument();
      expect(asked().filter((url) => url.startsWith(tmdb))).toEqual([findFrieren, frieren]);
    });

    it("keeps the addon's details when TMDB fails", async () => {
      serve();
      await renderApp(moviePath);

      expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("Cast", { selector: "dt" })).toBeInTheDocument());
      expect(screen.getByRole("img", { name: "The Shawshank Redemption" })).toHaveAttribute(
        "src",
        // Asked for large (#113); the logo is the same file at every size.
        cinemetaMovie.meta.logo.replace("/logo/medium/", "/logo/large/"),
      );
      expect(screen.queryByRole("heading", { name: "Cast" })).toBeNull();
    });
  });

  it("never asks TMDB without a key", async () => {
    const asked = serve();
    await renderApp(moviePath);

    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByText("Cast", { selector: "dt" })).toBeInTheDocument();
    expect(asked().some((url) => url.includes("themoviedb"))).toBe(false);
  });
});
