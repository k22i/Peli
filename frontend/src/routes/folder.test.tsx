import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  Addon,
  Collection,
  CollectionFolder,
  LibraryItem,
  Profile,
  Progress,
} from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  catalogVisible: vi.fn<
    (id: number, addon: string, type: string, catalog: string) => Promise<boolean>
  >(() => Promise.resolve(true)),
  collections: vi.fn<() => Promise<Collection[]>>(() => Promise.resolve([])),
  library: vi.fn<() => Promise<LibraryItem[]>>(() => Promise.resolve([])),
  continueWatching: vi.fn<() => Promise<Progress[]>>(() => Promise.resolve([])),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.visibleAddons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: mocks.catalogVisible,
    HomeLayout: () => Promise.resolve(null),
    Collections: mocks.collections,
    Library: mocks.library,
    ContinueWatching: mocks.continueWatching,
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
const cinemetaBase = "https://v3-cinemeta.strem.io/catalog";
const kitsuBase = "https://anime-kitsu.strem.fun/catalog";

const titlesOf = (prefix: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${from + i}`,
    type: "movie",
    name: `${prefix.toUpperCase()} ${from + i}`,
  }));

// Answers addon requests by full URL; anything else answers 503, as an
// addon that's down. Returns the URLs asked.
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

const picks: CollectionFolder = {
  id: "f1",
  title: "Picks",
  hideTitle: false,
  shape: "POSTER",
  cover: "https://img.example/picks.jpg",
  sources: [
    { addonId: "com.linvo.cinemeta", type: "movie", catalogId: "top", genre: "Drama" },
    { addonId: "org.uninstalled", type: "movie", catalogId: "top" },
    { addonId: "community.anime.kitsu", type: "anime", catalogId: "kitsu-anime-airing" },
  ],
};
const collection = (...folders: CollectionFolder[]): Collection => ({
  id: "c1",
  title: "Weekend",
  pinToTop: false,
  folders,
});

const grid = () => screen.findByRole("list", { name: "Picks" });
// Cards mount once the grid has measured its scroll container.
const titles = async (list: HTMLElement) =>
  (await within(list).findAllByRole("button")).map((card) => card.textContent);

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.visibleAddons.mockResolvedValue([cinemeta, kitsu]);
  mocks.catalogVisible.mockResolvedValue(true);
  mocks.collections.mockResolvedValue([collection(picks)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collection folders", () => {
  it("opens from its tile on Home as one grid of its catalogs", async () => {
    serve({
      [`${cinemetaBase}/movie/top/genre=Drama.json`]: {
        metas: [...titlesOf("tt", 1, 2), { id: "kitsu:1", type: "movie", name: "Shared" }],
        hasMore: false,
      },
      [`${kitsuBase}/anime/kitsu-anime-airing.json`]: {
        metas: [{ id: "kitsu:1", type: "movie", name: "Shared" }, ...titlesOf("kitsu:", 2, 2)],
        hasMore: false,
      },
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    const weekend = await screen.findByRole("region", { name: "Weekend" });
    await user.click(within(weekend).getByRole("button", { name: /Picks/ }));

    expect(router.state.location.pathname).toBe("/folder/c1/f1");
    const header = await screen.findByRole("region", { name: "Picks" });
    expect(within(header).getByRole("heading", { level: 1, name: "Picks" })).toBeInTheDocument();
    expect(within(header).getByText("Weekend")).toBeInTheDocument();
    // One from each catalog in turn; the uninstalled addon's is skipped, and
    // a title both list shows once.
    expect(await titles(await grid())).toEqual([
      expect.stringContaining("TT 1"),
      expect.stringContaining("Shared"),
      expect.stringContaining("TT 2"),
      expect.stringContaining("KITSU: 2"),
      expect.stringContaining("KITSU: 3"),
    ]);
  });

  it("draws the folder's title logo in place of its name", async () => {
    serve({});
    mocks.collections.mockResolvedValue([
      collection({ ...picks, logo: "https://img.example/picks-logo.png" }),
    ]);
    await renderApp("/folder/c1/f1");

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(within(heading).getByRole("img", { name: "Picks" })).toHaveAttribute(
      "src",
      "https://img.example/picks-logo.png",
    );
  });

  it("pages every catalog with skip", async () => {
    const asked = serve({
      [`${cinemetaBase}/movie/top/genre=Drama.json`]: {
        metas: titlesOf("tt", 1, 3),
        hasMore: true,
      },
      [`${cinemetaBase}/movie/top/genre=Drama&skip=3.json`]: { metas: titlesOf("tt", 4, 2) },
      [`${cinemetaBase}/movie/top/genre=Drama&skip=5.json`]: { metas: [] },
      [`${kitsuBase}/anime/kitsu-anime-airing.json`]: { metas: titlesOf("k", 1, 3) },
      [`${kitsuBase}/anime/kitsu-anime-airing/skip=3.json`]: { metas: [] },
    });
    await renderApp("/folder/c1/f1");

    await waitFor(async () => expect(await titles(await grid())).toHaveLength(8));
    expect(asked().filter((url) => url.includes("skip="))).toEqual(
      expect.arrayContaining([
        `${cinemetaBase}/movie/top/genre=Drama&skip=3.json`,
        `${cinemetaBase}/movie/top/genre=Drama&skip=5.json`,
        `${kitsuBase}/anime/kitsu-anime-airing/skip=3.json`,
      ]),
    );
  });

  it("leaves out a catalog a kids profile may not see", async () => {
    const asked = serve({
      [`${cinemetaBase}/movie/top/genre=Drama.json`]: {
        metas: titlesOf("tt", 1, 2),
        hasMore: false,
      },
    });
    mocks.catalogVisible.mockImplementation((_id, _addon, _type, catalog) =>
      Promise.resolve(catalog !== "kitsu-anime-airing"),
    );
    await renderApp("/folder/c1/f1");

    expect(await titles(await grid())).toHaveLength(2);
    expect(asked().some((url) => url.startsWith(kitsuBase))).toBe(false);
  });

  it("says when a folder's addons aren't installed", async () => {
    serve({});
    mocks.collections.mockResolvedValue([
      collection({
        ...picks,
        sources: [{ addonId: "org.uninstalled", type: "movie", catalogId: "top" }],
      }),
    ]);
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    await renderApp("/folder/c1/f1");

    expect(await screen.findByRole("heading", { name: "Nothing to show" })).toBeInTheDocument();
  });

  it("says when the folder is gone", async () => {
    serve({});
    mocks.collections.mockResolvedValue([collection()]);
    await renderApp("/folder/c1/f1");

    expect(
      await screen.findByRole("heading", { name: "This folder isn’t here any more" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });
});
