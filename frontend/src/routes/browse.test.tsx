import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Service as AnimeList } from "@bindings/animelist";
import type { Addon, HomeLayout, Profile } from "@bindings/store";
import { catalogQuery, manifestQuery } from "@/lib/addon-protocol";
import { parseCatalogResponse, parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaMovies from "@/lib/addon-protocol/fixtures/cinemeta/catalog-movie-top.json";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuTrending from "@/lib/addon-protocol/fixtures/kitsu/catalog-anime-trending.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  catalogVisible: vi.fn<
    (id: number, addon: string, type: string, catalog: string) => Promise<boolean>
  >(() => Promise.resolve(true)),
  homeLayout: vi.fn<() => Promise<HomeLayout | null>>(() => Promise.resolve(null)),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: mocks.catalogVisible,
    HomeLayout: mocks.homeLayout,
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

// Films numbered from `from`, as a catalog page lists them.
const films = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `tt${from + i}`,
    type: "movie",
    name: `Film ${from + i}`,
  }));

// Answers addon requests by full URL from these fixtures; anything else
// answers 503, as an addon that's down. Returns the URLs asked.
function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [kitsu.url]: kitsuManifest,
    ...answers,
  };
  const fetch = vi.fn<(url: string) => Promise<Response>>((url) =>
    Promise.resolve(url in all ? Response.json(all[url]) : new Response("", { status: 503 })),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => url);
}

const base = "https://v3-cinemeta.strem.io";
const chips = () => screen.getByRole("group", { name: "Catalogs" });
const grid = (name: string | RegExp) => screen.findByRole("list", { name });
// Cards mount once the grid has measured its scroll container.
const titles = async (list: HTMLElement) =>
  (await within(list).findAllByRole("button")).map((card) => card.textContent);

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta, kitsu]);
  mocks.visibleAddons.mockResolvedValue([cinemeta, kitsu]);
  mocks.catalogVisible.mockResolvedValue(true);
  mocks.homeLayout.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browse pages", () => {
  it("offers Movies' catalogs and shows the first", async () => {
    serve({ [`${base}/catalog/movie/top.json`]: { metas: cinemetaMovies.metas, hasMore: false } });
    await renderApp("/movies");

    expect(screen.getByRole("heading", { level: 1, name: "Movies" })).toBeInTheDocument();
    const popular = await grid("Popular");
    expect((await titles(popular))[0]).toContain(cinemetaMovies.metas[0]!.name);
    expect(
      within(chips())
        .getAllByRole("button")
        .map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")]),
    ).toEqual([
      ["Popular", "true"],
      ["New", "false"],
      ["Featured", "false"],
    ]);
    // Kitsu's anime catalogs are the Anime page's.
    expect(within(chips()).queryByRole("button", { name: /Kitsu/ })).toBeNull();
  });

  it("filters by the catalog's genres", async () => {
    const asked = serve({
      [`${base}/catalog/movie/top.json`]: { metas: films(1, 4), hasMore: false },
      [`${base}/catalog/movie/top/genre=Drama.json`]: { metas: films(100, 2), hasMore: false },
    });
    const user = userEvent.setup();
    await renderApp("/movies");
    await grid("Popular");

    const genre = screen.getByRole("combobox", { name: "Genre" });
    expect(genre).toHaveTextContent("All genres");
    await user.click(genre);
    await user.click(await screen.findByRole("option", { name: "Drama" }));

    expect(await titles(await grid("Popular, Drama"))).toEqual([
      expect.stringContaining("Film 100"),
      expect.stringContaining("Film 101"),
    ]);
    expect(asked()).toContain(`${base}/catalog/movie/top/genre=Drama.json`);
  });

  // Cinemeta's "New" takes years as its genre, and needs one.
  it("gives a catalog of years a Year filter, set to the newest", async () => {
    const asked = serve({
      [`${base}/catalog/movie/top.json`]: { metas: films(1, 4), hasMore: false },
      [`${base}/catalog/movie/year/genre=2026.json`]: { metas: films(200, 3), hasMore: false },
    });
    const user = userEvent.setup();
    await renderApp("/movies");
    await grid("Popular");

    await user.click(within(chips()).getByRole("button", { name: "New" }));

    expect(await grid("New, 2026")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Year" })).toHaveTextContent("2026");
    expect(screen.queryByRole("combobox", { name: "Genre" })).toBeNull();
    expect(asked()).not.toContain(`${base}/catalog/movie/year.json`);
  });

  // The address keeps the choice, so coming Back to the page restores it.
  it("opens on the catalog and genre in the address", async () => {
    serve({ [`${base}/catalog/movie/year/genre=2024.json`]: { metas: films(1, 2) } });
    const catalog = encodeURIComponent(`${cinemeta.url}|movie|year`);
    await renderApp(`/movies?catalog=${catalog}&genre=2024`);

    expect(await grid("New, 2024")).toBeInTheDocument();
    expect(within(chips()).getByRole("button", { name: "New" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("loads more with skip until the catalog runs out", async () => {
    const asked = serve({
      [`${base}/catalog/series/top.json`]: { metas: films(1, 4), hasMore: true },
      // Addons repeat titles across pages.
      [`${base}/catalog/series/top/skip=4.json`]: { metas: films(4, 4), hasMore: true },
      [`${base}/catalog/series/top/skip=8.json`]: { metas: [] },
    });
    await renderApp("/shows");

    const popular = await grid("Popular");
    await waitFor(async () => expect(await titles(popular)).toHaveLength(7));
    await waitFor(() => expect(asked()).toContain(`${base}/catalog/series/top/skip=8.json`));
    expect(asked().filter((url) => url.includes("skip="))).toEqual([
      `${base}/catalog/series/top/skip=4.json`,
      `${base}/catalog/series/top/skip=8.json`,
    ]);
  });

  it("shows Kitsu's catalogs on Anime, without paging one that has no skip", async () => {
    const asked = serve({
      [`${kitsu.url.replace("manifest.json", "")}catalog/anime/kitsu-anime-trending.json`]:
        kitsuTrending,
    });
    await renderApp("/anime");

    const trending = await grid("Kitsu Trending");
    expect(await titles(trending)).toHaveLength(kitsuTrending.metas.length);
    expect(within(chips()).getAllByRole("button")).toHaveLength(4);
    expect(within(chips()).queryByRole("button", { name: "Popular" })).toBeNull();
    // Trending takes no genre.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(asked().some((url) => url.includes("skip="))).toBe(false);
  });

  it("paints from Home's cache with no network", async () => {
    serve({});
    await renderApp("/movies", {
      seed: (client) => {
        const restored = { updatedAt: 1 };
        client.setQueryData(
          manifestQuery(cinemeta.url).queryKey,
          parseManifest(cinemetaManifest),
          restored,
        );
        client.setQueryData(
          manifestQuery(kitsu.url).queryKey,
          parseManifest(kitsuManifest),
          restored,
        );
        client.setQueryData(
          catalogQuery(cinemeta.url, "movie", "top").queryKey,
          parseCatalogResponse(cinemetaMovies),
          restored,
        );
      },
    });

    expect((await titles(await grid("Popular")))[0]).toContain(cinemetaMovies.metas[0]!.name);
  });

  it("leaves out the catalogs a kids profile wasn't allowed", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.catalogVisible.mockImplementation((_, __, type, id) =>
      Promise.resolve(!(type === "movie" && id === "top")),
    );
    serve({ [`${base}/catalog/movie/year/genre=2026.json`]: { metas: films(1, 2) } });
    await renderApp("/movies");

    expect(await grid("New, 2026")).toBeInTheDocument();
    expect(
      within(chips())
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["New", "Featured"]);
  });

  it("leaves anime to the Anime tab, reading on past a page of only anime", async () => {
    vi.mocked(AnimeList.IMDbIDs).mockResolvedValue({
      imdb: ["tt1", "tt2", "tt3", "tt4", "tt6"],
      ready: true,
    });
    const asked = serve({
      [`${base}/catalog/series/top.json`]: { metas: films(1, 4), hasMore: true },
      [`${base}/catalog/series/top/skip=4.json`]: { metas: films(5, 3), hasMore: false },
    });
    await renderApp("/shows");

    const popular = await grid("Popular");
    await waitFor(async () =>
      expect(await titles(popular)).toEqual([
        expect.stringContaining("Film 5"),
        expect.stringContaining("Film 7"),
      ]),
    );
    expect(asked()).toContain(`${base}/catalog/series/top/skip=4.json`);
  });

  it("hides unreleased titles when the layout says to", async () => {
    mocks.homeLayout.mockResolvedValue({ rows: [], hideUnreleased: true });
    serve({
      [`${base}/catalog/movie/top.json`]: {
        metas: [{ ...films(1, 1)[0], released: "2999-01-01T00:00:00.000Z" }, ...films(2, 2)],
      },
    });
    await renderApp("/movies");

    expect(await titles(await grid("Popular"))).toEqual([
      expect.stringContaining("Film 2"),
      expect.stringContaining("Film 3"),
    ]);
  });

  it("offers to retry a catalog that didn't load", async () => {
    serve({});
    await renderApp("/movies");

    expect(
      await screen.findByRole("heading", { name: "Couldn’t load Popular" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says when no addon lists the page's kind", async () => {
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    serve({});
    await renderApp("/anime");

    expect(await screen.findByRole("heading", { name: "No anime to browse" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage addons" })).toBeInTheDocument();
  });

  it("says how to add an addon when there are none", async () => {
    mocks.addons.mockResolvedValue([]);
    mocks.visibleAddons.mockResolvedValue([]);
    serve({});
    await renderApp("/shows");

    expect(
      await screen.findByRole("region", { name: "Add an addon to start watching" }),
    ).toBeInTheDocument();
  });
});
