import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile } from "@bindings/store";
import cinemetaMovies from "@/lib/addon-protocol/fixtures/cinemeta/catalog-movie-search.json";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { renderApp } from "@/test/render-app";

// Anything a page behind a command asks for that isn't mocked stays loading,
// so these tests only look at where the palette took them.
const loading = vi.hoisted(
  () =>
    <T extends object>(known: T): T =>
      new Proxy(known, {
        get: (target, key) =>
          key in target ? Reflect.get(target, key) : () => new Promise<never>(() => undefined),
      }),
);

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  catalogVisible: vi.fn<
    (id: number, addon: string, type: string, catalog: string) => Promise<boolean>
  >(() => Promise.resolve(true)),
  library: vi.fn<() => Promise<LibraryItem[]>>(),
  lastWatched: vi.fn<() => Promise<Record<string, number>>>(),
}));

// Anything a page behind a command asks for that isn't mocked stays loading,
// so these tests only look at where the palette took them.
vi.mock("@bindings/store", () => ({
  Service: loading({
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: mocks.catalogVisible,
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: mocks.library,
    LastWatched: mocks.lastWatched,
  }),
}));

vi.mock("@bindings/account", () => ({
  Service: loading({ Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) }),
}));

vi.mock("@bindings/player", () => ({ Service: loading({}) }));

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

const movieSearch = "https://v3-cinemeta.strem.io/catalog/movie/top/search=dune.json";
const seriesSearch = "https://v3-cinemeta.strem.io/catalog/series/top/search=dune.json";
const animeSearch = "https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-list/search=dune.json";

function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [kitsu.url]: kitsuManifest,
    ...answers,
  };
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url in all ? Response.json(all[url]) : new Response("", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url]) => url);
}

const searchAnswers = () =>
  serve({
    [movieSearch]: cinemetaMovies,
    [seriesSearch]: { metas: [{ id: "tt0142032", type: "series", name: "Dune (2000)" }] },
    [animeSearch]: { metas: [{ id: "kitsu:1", type: "series", name: "Dune Anime" }] },
  });

const palette = () => screen.findByRole("dialog", { name: "Command palette" });
const input = () => screen.getByRole("combobox", { name: "Search titles or jump to" });

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta, kitsu]);
  mocks.visibleAddons.mockResolvedValue([cinemeta, kitsu]);
  mocks.catalogVisible.mockResolvedValue(true);
  mocks.library.mockResolvedValue([]);
  mocks.lastWatched.mockResolvedValue({});
  serve({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command palette", () => {
  it("opens on Ctrl/⌘+K with the commands, and toggles closed", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await palette();
    expect(input()).toHaveFocus();
    for (const name of ["Home", "Movies", "Shows", "Anime", "Library", "Upcoming", "Search"]) {
      expect(within(dialog).getByRole("option", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    expect(within(dialog).getByRole("option", { name: /^Addons/ })).toBeVisible();
    expect(within(dialog).getByRole("option", { name: "Settings: Playback" })).toBeVisible();
    expect(within(dialog).getByRole("option", { name: "Switch profile" })).toBeVisible();

    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("searches titles as you type and opens the highlighted one with Enter", async () => {
    const asked = searchAnswers();
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    await palette();
    await user.type(input(), "dune");

    const dialog = await palette();
    expect(await within(dialog).findByRole("option", { name: /^Dune\s?2021$/ })).toBeVisible();
    expect(within(dialog).getByText("Movies")).toBeVisible();
    expect(within(dialog).getByRole("option", { name: "Dune (2000)" })).toBeVisible();
    expect(within(dialog).getByRole("option", { name: "Dune Anime" })).toBeVisible();
    expect(asked()).toContain(movieSearch);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt1160419"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves with the arrow keys", async () => {
    searchAnswers();
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    await palette();
    await user.type(input(), "dune");
    await screen.findByRole("option", { name: "Dune (2000)" });
    const shows = screen.getByRole("option", { name: "Dune (2000)" });
    // The movies come first, so it takes a few presses to get down to it.
    const before = screen.getAllByRole("option").indexOf(shows);
    await user.keyboard(`{ArrowDown>${before}/}`);
    expect(shows).toHaveAttribute("data-highlighted");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/series/tt0142032"));
  });

  it.each([
    ["upcoming", "/library", { view: "upcoming" }],
    ["movies", "/movies", {}],
    ["addons", "/addons", {}],
    ["settings playback", "/settings", { section: "playback" }],
    ["switch profile", "/profiles", {}],
  ])("runs the %s command", async (query, pathname, search) => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    await palette();
    await user.type(input(), query);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
    expect(router.state.location.search).toEqual(search);
  });

  it("closes on Escape and puts focus back where it was", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    const link = screen.getByRole("link", { name: "Movies" });
    link.focus();

    await user.keyboard("{Meta>}k{/Meta}");
    await palette();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(link).toHaveFocus();
  });

  it("lists the last titles watched before anything is typed", async () => {
    mocks.library.mockResolvedValue([
      { contentId: "tt1", contentType: "movie", name: "Older", releaseInfo: "2001", addedAt: 1 },
      { contentId: "tt2", contentType: "movie", name: "Newer", releaseInfo: "2020", addedAt: 2 },
      { contentId: "tt3", contentType: "movie", name: "Never watched", addedAt: 3 },
    ] satisfies LibraryItem[]);
    mocks.lastWatched.mockResolvedValue({ tt1: 100, tt2: 200 });
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await palette();
    const options = await within(dialog).findAllByRole("option", { name: /^(Older|Newer)/ });
    expect(options.map((option) => option.textContent)).toEqual(["Newer2020", "Older2001"]);
    expect(within(dialog).queryByRole("option", { name: /Never watched/ })).toBeNull();

    await user.click(options[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt2"));
  });

  it("leaves out what a kids profile isn't allowed", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    mocks.catalogVisible.mockImplementation((_, __, type) => Promise.resolve(type === "movie"));
    const asked = searchAnswers();
    const user = userEvent.setup();
    await renderApp("/");

    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await palette();
    expect(within(dialog).queryByRole("option", { name: /^Addons/ })).toBeNull();
    await user.type(input(), "dune");

    expect(await within(dialog).findByRole("option", { name: /^Dune\s?2021$/ })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
    expect(within(dialog).queryByRole("option", { name: "Dune (2000)" })).toBeNull();
    expect(within(dialog).queryByRole("option", { name: "Dune Anime" })).toBeNull();
    expect(
      asked()
        .map(String)
        .filter((url) => url.includes("search=")),
    ).toEqual([movieSearch]);
  });

  it("isn't there on the player", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/player", { shell: false });
    await waitFor(() => expect(router.state.location.pathname).toBe("/player"));

    await user.keyboard("{Meta>}k{/Meta}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isn't there before a profile is picked", async () => {
    const user = userEvent.setup();
    await renderApp("/welcome", { shell: false });

    await user.keyboard("{Meta>}k{/Meta}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("stays shut over a PIN-locked profile", async () => {
    mocks.current.mockResolvedValue({ ...kevin, pinEnabled: true });
    const user = userEvent.setup();
    await renderApp("/", { shell: false });
    await screen.findByRole("navigation", { name: "Main" });

    await user.keyboard("{Meta>}k{/Meta}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});
