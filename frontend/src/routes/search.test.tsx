import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, HomeLayout, Profile } from "@bindings/store";
import cinemetaMovies from "@/lib/addon-protocol/fixtures/cinemeta/catalog-movie-search.json";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
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
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
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

const movieSearch = (q: string) =>
  `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`;
const seriesSearch = (q: string) =>
  `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`;
const animeSearch = (q: string) =>
  `https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-list/search=${encodeURIComponent(q)}.json`;

const shows = { metas: [{ id: "tt0142032", type: "series", name: "Dune (2000)" }] };
const anime = { metas: [{ id: "kitsu:1", type: "series", name: "Dune Anime" }] };

// Answers addon requests by full URL: a body, or a promise of one for an
// addon that answers when the test says. Anything else answers 503, as an
// addon that's down. Returns the URLs asked.
function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [kitsu.url]: kitsuManifest,
    ...answers,
  };
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url in all ? Response.json(await all[url]) : new Response("", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => url);
}

// A promise the test resolves, for an addon that answers late.
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A row's heading is its kind and the addons behind it ("Movies · Cinemeta").
const named = (name: string) => ({ name: new RegExp(`^${name}( ·|$)`) });
const row = (name: string) => screen.findByRole("region", named(name));
// Cards mount once the row has measured its scroller.
const titles = async (region: HTMLElement) =>
  (await within(region).findAllByRole("button")).map((card) => card.textContent);
const field = () => screen.getByRole("searchbox", { name: "Search" });

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

describe("search", () => {
  it("shows the fastest addon's results while a slower one is still searching", async () => {
    const kitsuAnswer = later<unknown>();
    serve({
      [movieSearch("dune")]: cinemetaMovies,
      [seriesSearch("dune")]: shows,
      [animeSearch("dune")]: kitsuAnswer.promise,
    });
    await renderApp("/search?q=dune");

    expect((await titles(await row("Movies")))[0]).toContain("Dune");
    expect(await titles(await row("Shows"))).toEqual([expect.stringContaining("Dune (2000)")]);
    expect(screen.getByText("Searching Anime Kitsu…")).toBeInTheDocument();
    expect(screen.queryByRole("region", named("Anime"))).toBeNull();

    kitsuAnswer.resolve(anime);
    expect(await titles(await row("Anime"))).toEqual([expect.stringContaining("Dune Anime")]);
    expect(screen.queryByText(/Searching/)).toBeNull();
  });

  it("searches once typing pauses and keeps the query in the address", async () => {
    const asked = serve({
      [movieSearch("dune")]: cinemetaMovies,
      [seriesSearch("dune")]: shows,
      [animeSearch("dune")]: anime,
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/search");

    expect(
      await screen.findByRole("heading", { name: "Search your addons’ catalogs" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(field()).toHaveFocus());
    await user.type(field(), "dune");

    expect(await row("Movies")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ q: "dune" });
    // One search per catalog, for the whole word.
    expect(asked().filter((url) => url.includes("search="))).toEqual([
      movieSearch("dune"),
      seriesSearch("dune"),
      animeSearch("dune"),
    ]);
  });

  it("names the addons behind each row in its heading", async () => {
    serve({
      [movieSearch("dune")]: cinemetaMovies,
      [seriesSearch("dune")]: shows,
      [animeSearch("dune")]: anime,
    });
    await renderApp("/search?q=dune");

    expect(await screen.findByRole("region", { name: "Movies · Cinemeta" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Shows · Cinemeta" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Anime · Anime Kitsu" })).toBeInTheDocument();
  });

  it("clears the field with its button and puts the cursor back in it", async () => {
    serve({ [movieSearch("dune")]: cinemetaMovies, [seriesSearch("dune")]: shows });
    const user = userEvent.setup();
    const { router } = await renderApp("/search?q=dune");

    await row("Movies");
    expect(field()).toHaveValue("dune");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("hints the shortcut while the field is empty and not focused", async () => {
    serve({});
    const user = userEvent.setup();
    await renderApp("/search");

    const bar = field().closest("[data-slot='input-control']")!.parentElement!;
    await waitFor(() => expect(field()).toHaveFocus());
    expect(within(bar).queryByText(/^(⌘F|Ctrl\+F)$/)).toBeNull();
    await user.click(document.body);
    expect(await within(bar).findByText(/^(⌘F|Ctrl\+F)$/)).toBeInTheDocument();
    await user.type(field(), "d");
    expect(within(bar).queryByText(/^(⌘F|Ctrl\+F)$/)).toBeNull();
  });

  it("shows a query from the address", async () => {
    serve({ [movieSearch("dune")]: cinemetaMovies });
    await renderApp("/search?q=dune");

    expect(await row("Movies")).toBeInTheDocument();
    expect(field()).toHaveValue("dune");
  });

  it("never asks the addons and catalogs a kids profile wasn't allowed", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    // Kitsu isn't on the allow-list, so VisibleAddons leaves it out, and of
    // Cinemeta only the movie catalogs are allowed.
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    mocks.catalogVisible.mockImplementation((_, __, type) => Promise.resolve(type === "movie"));
    const asked = serve({
      [movieSearch("dune")]: cinemetaMovies,
      [seriesSearch("dune")]: shows,
      [animeSearch("dune")]: anime,
    });
    await renderApp("/search?q=dune");

    expect(await row("Movies")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Searching/)).toBeNull());
    expect(screen.queryByRole("region", named("Shows"))).toBeNull();
    expect(asked().filter((url) => url.includes("search="))).toEqual([movieSearch("dune")]);
    expect(asked().some((url) => url.startsWith("https://anime-kitsu.strem.fun"))).toBe(false);
  });

  it("keeps the other results when an addon doesn't answer, and retries it", async () => {
    const asked = serve({ [movieSearch("dune")]: cinemetaMovies, [seriesSearch("dune")]: shows });
    const user = userEvent.setup();
    await renderApp("/search?q=dune");

    expect(await row("Movies")).toBeInTheDocument();
    expect(await screen.findByText("Anime Kitsu didn’t answer.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(asked().filter((url) => url === animeSearch("dune"))).toHaveLength(2),
    );
  });

  it("says when nothing was found", async () => {
    serve({
      [movieSearch("zzzz")]: { metas: [] },
      [seriesSearch("zzzz")]: { metas: [] },
      [animeSearch("zzzz")]: { metas: [] },
    });
    await renderApp("/search?q=zzzz");

    expect(
      await screen.findByRole("heading", { name: "No results for “zzzz”" }),
    ).toBeInTheDocument();
  });

  it("says when no addon can search", async () => {
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    mocks.catalogVisible.mockResolvedValue(false);
    serve({});
    await renderApp("/search?q=dune");

    expect(
      await screen.findByRole("heading", { name: "None of your addons can search" }),
    ).toBeInTheDocument();
  });

  it("opens from anywhere with ⌘F or /", async () => {
    serve({});
    const user = userEvent.setup();
    const { router } = await renderApp("/settings");

    await user.keyboard("{Meta>}f{/Meta}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    await waitFor(() => expect(field()).toHaveFocus());

    await user.type(field(), "a/");
    expect(field()).toHaveValue("a/");
    await user.click(screen.getByRole("heading", { level: 1, name: "Search" }));
    await user.keyboard("/");
    expect(field()).toHaveFocus();
  });

  it("arrows from the field into the results and back", async () => {
    serve({ [movieSearch("dune")]: cinemetaMovies, [seriesSearch("dune")]: shows });
    const user = userEvent.setup();
    await renderApp("/search?q=dune");

    const movies = await row("Movies");
    await titles(await row("Shows"));
    await user.click(field());
    await user.keyboard("{ArrowDown}");
    const [first, second] = within(movies).getAllByRole("button");
    expect(first).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(await row("Shows")).getByRole("button")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(field()).toHaveFocus();
  });
});
