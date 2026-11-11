import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile, WatchedItem } from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import { renderApp } from "@/test/render-app";

// Search's filters, recent searches and People row, and Home's New episodes
// and Surprise me.

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  library: [] as LibraryItem[],
  watched: [] as WatchedItem[],
  // Each profile's recent searches, as the store keeps them.
  recent: new Map<number, string[]>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: () => Promise.resolve([cinemeta]),
    VisibleAddons: () => Promise.resolve([cinemeta]),
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: () => Promise.resolve([...mocks.library]),
    Watched: () => Promise.resolve([...mocks.watched]),
    RecentSearches: (id: number) => Promise.resolve([...(mocks.recent.get(id) ?? [])]),
    SetRecentSearches: (id: number, list: string[]) => {
      mocks.recent.set(id, list);
      return Promise.resolve();
    },
    LastWatched: () => Promise.resolve({}),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
  },
}));
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
const base = "https://v3-cinemeta.strem.io";
const tmdb = "https://api.themoviedb.org/3";

const movies = {
  metas: [
    { id: "tt1", type: "movie", name: "Dune", releaseInfo: "1984", genres: ["Sci-Fi"] },
    {
      id: "tt2",
      type: "movie",
      name: "Dune Two",
      releaseInfo: "2024",
      genres: ["Sci-Fi", "Drama"],
    },
    { id: "tt3", type: "movie", name: "Dune Three", releaseInfo: "2026", genres: ["Drama"] },
  ],
};
const shows = { metas: [{ id: "tt4", type: "series", name: "Dune Show", releaseInfo: "2001" }] };
const search = (type: string, q: string) =>
  `${base}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`;

// Answers by full URL; anything else is a 503 (an addon that's down).
function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = { [cinemeta.url]: cinemetaManifest, ...answers };
  const fetch = vi.fn<(url: string | URL) => Promise<Response>>(async (input) => {
    const url = String(input);
    return url in all ? Response.json(all[url]) : new Response("", { status: 503 });
  });
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => String(url));
}

// The first render loads route chunks cold, on a machine that may be busy.
configure({ asyncUtilTimeout: 8000 });

const card = (name: RegExp | string) => screen.findByRole("button", { name });
const field = () => screen.findByRole("searchbox", { name: "Search" });

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.library = [];
  mocks.watched = [];
  mocks.recent.clear();
  keychain.tmdb = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("search filters", () => {
  const answers = { [search("movie", "dune")]: movies, [search("series", "dune")]: shows };

  it("narrows by kind, keeping it in the address", async () => {
    serve(answers);
    const { router } = await renderApp("/search?q=dune");
    await card(/Dune Show/);
    expect(await card(/^Dune 1984/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Shows" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Dune Two/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Dune Show/ })).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ q: "dune", type: "series" });
  });

  it("narrows by decade and genre from the address", async () => {
    serve(answers);
    await renderApp("/search?q=dune&year=2020");
    await card(/Dune Two/);
    expect(screen.getByRole("button", { name: /Dune Three/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Dune 1984/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Dune Show/ })).toBeNull();
  });

  it("filters by genre", async () => {
    serve(answers);
    await renderApp("/search?q=dune&genre=Drama");
    await card(/Dune Three/);
    expect(screen.getByRole("button", { name: /Dune Two/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Dune 1984/ })).toBeNull();
  });

  it("says when nothing matches and clears the filters", async () => {
    serve(answers);
    await renderApp("/search?q=dune&year=1990&type=series");
    expect(await screen.findByText("Nothing matches those filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await card(/Dune Show/)).toBeInTheDocument();
  });
});

describe("recent searches", () => {
  it("remembers a search on Enter, shows it under the empty field, removes and clears", async () => {
    serve({ [search("movie", "dune")]: movies });
    await renderApp("/search");
    const input = await field();
    await userEvent.type(input, "dune{Enter}");
    await card(/^Dune 1984/);
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(await screen.findByRole("heading", { name: "Recent searches" })).toBeInTheDocument();
    await userEvent.type(await field(), "arrival{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Clear search" }));
    // Newest first.
    const chips = (await screen.findAllByRole("button", { name: /^(dune|arrival)$/ })).map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["arrival", "dune"]);

    await userEvent.click(screen.getByRole("button", { name: "Remove arrival" }));
    expect(screen.queryByRole("button", { name: "arrival" })).toBeNull();
    // A recent search runs again when picked.
    await userEvent.click(screen.getByRole("button", { name: "dune" }));
    expect(await card(/^Dune 1984/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    expect(screen.queryByRole("heading", { name: "Recent searches" })).toBeNull();
  });

  it("keeps each profile's own list", async () => {
    mocks.recent.set(2, ["other profile"]);
    mocks.recent.set(1, ["mine"]);
    serve({});
    await renderApp("/search");
    expect(await screen.findByRole("button", { name: "mine" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "other profile" })).toBeNull();
  });
});

describe("people in results", () => {
  const people = `${tmdb}/search/person?query=dune&api_key=key`;
  const hits = {
    results: [
      {
        id: 287,
        name: "Dune Person",
        known_for_department: "Acting",
        profile_path: "/p.jpg",
        known_for: [{ title: "Dune" }, { name: "A Show" }],
      },
    ],
  };

  it("lists TMDB's people and opens their page", async () => {
    keychain.tmdb = "key";
    serve({ [search("movie", "dune")]: movies, [people]: hits });
    const { router } = await renderApp("/search?q=dune");

    await userEvent.click(await card(/Dune Person/));
    expect(router.state.location.pathname).toBe("/person/287");
  });

  it("is absent without a key, and without asking TMDB", async () => {
    const asked = serve({ [search("movie", "dune")]: movies, [people]: hits });
    await renderApp("/search?q=dune");
    await card(/^Dune 1984/);
    expect(screen.queryByRole("button", { name: /Dune Person/ })).toBeNull();
    expect(asked().some((url) => url.includes("themoviedb"))).toBe(false);
  });

  it("is absent on a kids profile", async () => {
    keychain.tmdb = "key";
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    const asked = serve({ [search("movie", "dune")]: movies, [people]: hits });
    await renderApp("/search?q=dune");
    await card(/^Dune 1984/);
    expect(screen.queryByRole("button", { name: /Dune Person/ })).toBeNull();
    expect(asked().some((url) => url.includes("search/person"))).toBe(false);
  });
});

const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const show = (id: string, name: string): LibraryItem => ({
  contentId: id,
  contentType: "series",
  name,
  addedAt: 1,
});
const meta = (id: string, name: string, ...released: string[]) => ({
  [`${base}/meta/series/${id}.json`]: {
    meta: {
      id,
      type: "series",
      name,
      videos: released.map((date, i) => ({
        id: `${id}:1:${i + 1}`,
        name: `Episode ${i + 1}`,
        season: 1,
        number: i + 1,
        episode: i + 1,
        released: date,
      })),
    },
  },
});
const topMovies = {
  [`${base}/catalog/movie/top.json`]: {
    metas: [
      { id: "tt900", type: "movie", name: "Catalog Hero", background: "https://x.test/b.jpg" },
    ],
  },
};

describe("Home: New episodes", () => {
  it("lists shows with an episode in the last 7 days, newest first", async () => {
    mocks.library = [
      show("ttA", "Older Show"),
      show("ttB", "Newest Show"),
      show("ttC", "Too Old"),
      show("ttD", "Not Out Yet"),
    ];
    serve({
      ...meta("ttA", "Older Show", ago(5)),
      ...meta("ttB", "Newest Show", ago(10), ago(1)),
      ...meta("ttC", "Too Old", ago(9)),
      ...meta("ttD", "Not Out Yet", new Date(Date.now() + 2 * day).toISOString()),
    });
    await renderApp("/");

    const heading = await screen.findByRole("heading", { name: "New episodes" });
    const cards = await within(heading.closest("section")!).findAllByRole("button");
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Newest Show"),
      expect.stringContaining("Older Show"),
    ]);
    // The newest's own episode, not the older one.
    expect(cards[0]).toHaveTextContent("S1 · E2");
  });

  it("has no row when nothing aired this week", async () => {
    mocks.library = [show("ttC", "Too Old")];
    serve(meta("ttC", "Too Old", ago(9)));
    await renderApp("/");
    await screen.findByRole("heading", { name: "Your library" });
    expect(screen.queryByRole("heading", { name: "New episodes" })).toBeNull();
  });
});

const movie = (id: string, name: string): LibraryItem => ({
  contentId: id,
  contentType: "movie",
  name,
  addedAt: 1,
});
const mark = (id: string): WatchedItem => ({
  contentId: id,
  contentType: "movie",
  watchedAt: 1,
});

describe("Home: Surprise me", () => {
  it("opens an unwatched title from the library", async () => {
    mocks.library = [movie("tt1", "One"), movie("tt2", "Two"), movie("tt3", "Three")];
    mocks.watched = [mark("tt1"), mark("tt3")];
    serve(topMovies);
    const { router } = await renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "Surprise me" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt2"));
  });

  it("falls back to the first catalog when the library is all watched", async () => {
    mocks.library = [movie("tt1", "One")];
    mocks.watched = [mark("tt1")];
    serve(topMovies);
    const { router } = await renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "Surprise me" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt900"));
  });
});
