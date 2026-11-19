import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  Addon,
  Collection,
  HomeLayout,
  LibraryItem,
  Profile,
  Progress,
} from "@bindings/store";
import type * as Runtime from "@wailsio/runtime";
import { catalogQuery, manifestQuery } from "@/lib/addon-protocol";
import { parseCatalogResponse, parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaMovies from "@/lib/addon-protocol/fixtures/cinemeta/catalog-movie-top.json";
import cinemetaShows from "@/lib/addon-protocol/fixtures/cinemeta/catalog-series-top-skip.json";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  library: vi.fn<() => Promise<LibraryItem[]>>(),
  continueWatching: vi.fn<() => Promise<Progress[]>>(),
  homeLayout: vi.fn<() => Promise<HomeLayout | null>>(() => Promise.resolve(null)),
  collections: vi.fn<() => Promise<Collection[]>>(() => Promise.resolve([])),
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  catalogVisible: vi.fn<
    (id: number, addon: string, type: string, catalog: string) => Promise<boolean>
  >(() => Promise.resolve(true)),
  installAddon: vi.fn<(id: number, addon: Addon) => Promise<void>>(() => Promise.resolve()),
  connection: vi.fn<() => Promise<string>>(),
  checkConnection: vi.fn<() => Promise<string>>(),
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

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: mocks.catalogVisible,
    Library: mocks.library,
    ContinueWatching: mocks.continueWatching,
    HomeLayout: mocks.homeLayout,
    Collections: mocks.collections,
  },
}));

vi.mock("@bindings/account", () => ({
  Service: {
    Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }),
    InstallAddon: mocks.installAddon,
  },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: mocks.connection,
    CheckConnection: mocks.checkConnection,
  },
}));

const dune: LibraryItem = {
  contentId: "tt1160419",
  contentType: "movie",
  name: "Dune",
  releaseInfo: "2021",
  addedAt: 2000,
};
const severance: LibraryItem = {
  contentId: "tt11280740",
  contentType: "series",
  name: "Severance",
  addedAt: 1000,
};
const episode: Progress = {
  key: "tt11280740_s1e2",
  contentId: "tt11280740",
  contentType: "series",
  videoId: "tt11280740:1:2",
  season: 1,
  episode: 2,
  position: 600_000,
  duration: 3_000_000,
  lastWatched: 5_000_000,
};

const row = (name: string) => screen.findByRole("region", { name });
const empty = () => screen.findByRole("region", { name: "Add an addon to start watching" });

const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};

// Answers addon requests from these fixtures, by path under Cinemeta's
// address; anything else answers 503, as an addon that's down.
function serve(answers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = url.replace("https://v3-cinemeta.strem.io/", "");
      return Promise.resolve(
        path in answers ? Response.json(answers[path]) : new Response("", { status: 503 }),
      );
    }),
  );
}

beforeEach(() => {
  serve({ "manifest.json": cinemetaManifest });
  mocks.catalogVisible.mockResolvedValue(true);
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta]);
  mocks.visibleAddons.mockResolvedValue([cinemeta]);
  mocks.homeLayout.mockResolvedValue(null);
  mocks.collections.mockResolvedValue([]);
});

describe("Home", () => {
  // The acceptance criterion: with no network, Home opens with the library
  // and Continue Watching, and says it's offline without getting in the way.
  it("opens offline with the library and Continue Watching from the store", async () => {
    mocks.library.mockResolvedValue([dune, severance]);
    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.connection.mockResolvedValue("offline");

    await renderApp("/");

    const watching = await row("Continue watching");
    const card = within(watching).getByRole("button", { name: /Severance/ });
    expect(card).toHaveTextContent("S1 · E2");
    expect(card).toHaveTextContent("20% watched");
    const library = await row("Your library");
    expect(
      within(library)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("Dune"), expect.stringContaining("Severance")]);
    expect(await screen.findByRole("button", { name: /^Offline\./ })).toBeInTheDocument();
    expect(mocks.library).toHaveBeenCalledWith(1);
  });

  it("refreshes when a pull brings something in", async () => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");

    await renderApp("/");
    await row("Your library");
    expect(screen.queryByRole("region", { name: "Continue watching" })).toBeNull();

    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.handlers.get("sync:pulled")?.({ data: { profileId: 1, surfaces: ["progress"] } });

    expect(await row("Continue watching")).toBeInTheDocument();
  });

  // F7 (#35): collections made in Nuvio's apps show as rows of their
  // folders, in the order of the layout, and a pull brings changes in.
  it("shows collections in the layout's order", async () => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.connection.mockResolvedValue("online");
    const streaming: Collection = {
      id: "c1",
      title: "Streaming",
      pinToTop: false,
      folders: [
        { id: "f1", title: "Netflix", hideTitle: false, shape: "LANDSCAPE", sources: [] },
        { id: "f2", title: "Max", hideTitle: false, shape: "POSTER", sources: [] },
      ],
    };
    const anime: Collection = {
      id: "c2",
      title: "Anime",
      pinToTop: false,
      folders: [{ id: "f3", title: "Seasonal", hideTitle: false, sources: [] }],
    };
    mocks.collections.mockResolvedValue([streaming, anime]);
    mocks.homeLayout.mockResolvedValue({
      rows: [
        { key: "collection_c2", collectionId: "c2", enabled: true },
        { key: "collection_c1", collectionId: "c1", enabled: true },
      ],
      hideUnreleased: false,
    });

    await renderApp("/");

    const netflix = within(await row("Streaming")).getByRole("button", { name: /Netflix/ });
    expect(netflix).toHaveAttribute("data-slot", "landscape-card");
    expect(within(await row("Streaming")).getByRole("button", { name: /Max/ })).toHaveAttribute(
      "data-slot",
      "poster-card",
    );
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(["Continue watching", "Anime", "Streaming", "Your library"]);

    // Turned off in another app: gone after the next pull.
    mocks.homeLayout.mockResolvedValue({
      rows: [{ key: "collection_c2", collectionId: "c2", enabled: false }],
      hideUnreleased: false,
    });
    mocks.handlers.get("sync:pulled")?.({ data: { profileId: 1, surfaces: ["homeLayout"] } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Anime" })).toBeNull());
    expect(await row("Streaming")).toBeInTheDocument();
  });

  it("says what will show up when there's nothing yet", async () => {
    serve({ "manifest.json": { ...cinemetaManifest, catalogs: [] } });
    mocks.library.mockResolvedValue([]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");

    await renderApp("/");

    expect(await screen.findByText("Titles you save and watch show up here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });
});

// A film in progress.
function progressOn(contentId: string): Progress {
  const { season: _season, episode: _episode, ...entry } = episode;
  return { ...entry, key: contentId, contentId, contentType: "movie", videoId: contentId };
}

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

// #42: the hero, catalog rows in the user's order, and resuming in a click.
describe("catalogs", () => {
  const theInvite = cinemetaMovies.metas[0]!;

  beforeEach(() => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([episode]);
    mocks.connection.mockResolvedValue("online");
    serve({
      "manifest.json": cinemetaManifest,
      "catalog/movie/top.json": cinemetaMovies,
      "catalog/series/top.json": cinemetaShows,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("features the first catalog's first title and plays it", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    const hero = await screen.findByRole("region", { name: theInvite.name });
    expect(hero).toHaveTextContent("Popular · Movies");
    expect(hero).toHaveTextContent("IMDb 7.5");
    await user.click(within(hero).getByRole("button", { name: "Play" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: theInvite.name }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/streams/movie/${theInvite.id}`);
  });

  // #113: big cards, so a catalog row shows ten and links to the rest.
  it("shows ten titles of a catalog and links to its browse page", async () => {
    const user = userEvent.setup();
    const metas = Array.from({ length: 14 }, (_, i) => ({
      ...theInvite,
      id: `tt900000${i}`,
      name: `Extra ${i + 1}`,
    }));
    serve({
      "manifest.json": cinemetaManifest,
      "catalog/movie/top.json": { metas },
      "catalog/series/top.json": cinemetaShows,
    });
    await renderApp("/");

    const popular = await row("Popular · Movies");
    const link = within(popular).getByRole("link", { name: "Browse all" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/movies?catalog="));
    within(popular)
      .getByRole("button", { name: /^Extra 1(\s|$)/ })
      .focus();
    await user.keyboard("{End}");
    expect(await screen.findByRole("button", { name: /^Extra 10(\s|$)/ })).toHaveFocus();
  });

  it("offers Resume when the featured title is in Continue Watching", async () => {
    mocks.continueWatching.mockResolvedValue([progressOn(theInvite.id)]);
    await renderApp("/");

    const hero = await screen.findByRole("region", { name: theInvite.name });
    expect(within(hero).getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  // ← and → page the rotating hero while focus is in it; focus stays on the
  // same control of the new title, and wraps at the ends.
  it("pages the hero with the arrow keys while it has focus", async () => {
    const user = userEvent.setup();
    const [first, second] = cinemetaMovies.metas.filter((meta) => meta.background);
    await renderApp("/");

    const hero = await screen.findByRole("region", { name: first!.name });
    within(hero).getByRole("button", { name: "Play" }).focus();
    await user.keyboard("{ArrowRight}");
    const next = await screen.findByRole("region", { name: second!.name });
    expect(within(next).getByRole("button", { name: "Play" })).toHaveFocus();
    expect(screen.getByText(new RegExp(`^2 of \\d: ${second!.name}$`))).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    const back = await screen.findByRole("region", { name: first!.name });
    expect(within(back).getByRole("button", { name: "Play" })).toHaveFocus();

    // From the first, ← wraps to the last.
    await user.keyboard("{ArrowLeft}");
    const dots = screen.getAllByRole("button", { name: /^Show / });
    expect(dots.at(-1)).toHaveAttribute("aria-current", "true");
  });

  it("moves focus to the new title's dash when paged from a dash", async () => {
    const user = userEvent.setup();
    const [first, second] = cinemetaMovies.metas.filter((meta) => meta.background);
    await renderApp("/");

    await screen.findByRole("region", { name: first!.name });
    screen.getByRole("button", { name: `Show ${first!.name}` }).focus();
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("region", { name: second!.name });
    expect(screen.getByRole("button", { name: `Show ${second!.name}` })).toHaveFocus();
  });

  it("leaves the arrow keys alone outside the hero", async () => {
    const user = userEvent.setup();
    const first = cinemetaMovies.metas.find((meta) => meta.background);
    await renderApp("/");

    await screen.findByRole("region", { name: first!.name });
    within(await row("Popular · Movies"))
      .getAllByRole("button")[0]!
      .focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("region", { name: first!.name })).toBeInTheDocument();
  });

  // Reduced motion: the hero never turns by itself, but the keys still page it.
  it("never rotates the hero by itself with reduced motion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      const [first, second] = cinemetaMovies.metas.filter((meta) => meta.background);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderApp("/");

      const hero = await screen.findByRole("region", { name: first!.name });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.getByRole("region", { name: first!.name })).toBe(hero);

      within(hero).getByRole("button", { name: "Play" }).focus();
      await user.keyboard("{ArrowRight}");
      expect(await screen.findByRole("region", { name: second!.name })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // The acceptance criterion: from launch, resuming takes one click here,
  // then the stream picker's one (#52), within the three allowed.
  it("resumes a Continue Watching entry in one click", async () => {
    mocks.library.mockResolvedValue([dune, severance]);
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.click(
      within(await row("Continue watching")).getByRole("button", { name: /Severance/ }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Severance" })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/streams\//);
  });

  it("names a Continue Watching entry from its meta when it isn't saved", async () => {
    mocks.library.mockResolvedValue([]);
    mocks.continueWatching.mockResolvedValue([progressOn("tt0903747")]);
    serve({
      "manifest.json": cinemetaManifest,
      "meta/movie/tt0903747.json": {
        meta: { id: "tt0903747", type: "movie", name: "Breaking Bad" },
      },
    });
    await renderApp("/");

    expect(
      await within(await row("Continue watching")).findByRole("button", { name: /Breaking Bad/ }),
    ).toBeInTheDocument();
  });

  it("orders rows by the layout, then the rest in addon order", async () => {
    mocks.homeLayout.mockResolvedValue({
      rows: [
        {
          key: "s",
          addonId: cinemetaManifest.id,
          type: "series",
          catalogId: "top",
          enabled: true,
          title: "Top shows",
        },
        { key: "m", addonId: cinemetaManifest.id, type: "movie", catalogId: "top", enabled: false },
      ],
      hideUnreleased: false,
    });
    serve({
      "manifest.json": cinemetaManifest,
      "catalog/movie/top.json": cinemetaMovies,
      "catalog/series/top.json": cinemetaShows,
      "catalog/movie/imdbRating.json": cinemetaMovies,
      "catalog/series/imdbRating.json": cinemetaShows,
    });
    await renderApp("/");

    await row("Featured · Shows");
    expect(headings()).toEqual([
      "Continue watching",
      "Top shows",
      "Featured · Movies",
      "Featured · Shows",
      "Your library",
    ]);
    // The featured row is the layout's first.
    expect(await screen.findByRole("region", { name: "One Piece" })).toBeInTheDocument();
  });

  it("leaves out the catalogs a kids profile wasn't allowed", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.catalogVisible.mockImplementation((_, __, type) => Promise.resolve(type === "series"));
    await renderApp("/");

    await row("Popular · Shows");
    expect(screen.queryByRole("region", { name: "Popular · Movies" })).toBeNull();
    expect(mocks.catalogVisible).toHaveBeenCalledWith(1, cinemeta.url, "movie", "top");
  });

  // The budget (#8): Home is interactive from cache, not from the network.
  it("renders catalog rows from the persisted cache with no network", async () => {
    serve({});
    await renderApp("/", {
      seed: (client) => {
        // As restored from disk: stale, so refetched behind the cached page.
        const restored = { updatedAt: 1 };
        client.setQueryData(
          manifestQuery(cinemeta.url).queryKey,
          parseManifest(cinemetaManifest),
          restored,
        );
        client.setQueryData(
          catalogQuery(cinemeta.url, "movie", "top").queryKey,
          parseCatalogResponse(cinemetaMovies),
          restored,
        );
      },
    });

    expect(
      within(await row("Popular · Movies")).getByRole("button", { name: /Tenzing/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: theInvite.name })).toBeInTheDocument();
  });

  it("hides unreleased titles when the layout says to", async () => {
    mocks.homeLayout.mockResolvedValue({ rows: [], hideUnreleased: true });
    const [first, ...rest] = cinemetaMovies.metas;
    serve({
      "manifest.json": cinemetaManifest,
      "catalog/movie/top.json": {
        metas: [{ ...first, released: "2999-01-01T00:00:00.000Z" }, ...rest],
      },
    });
    await renderApp("/");

    const movies = await row("Popular · Movies");
    expect(within(movies).queryByRole("button", { name: /The Invite/ })).toBeNull();
    expect(await screen.findByRole("region", { name: "Tenzing" })).toBeInTheDocument();
  });
});

// #39: Peli bundles no addons, so a fresh install has none. Home explains
// what they are and installs one, rather than opening on nothing.
describe("with no addons", () => {
  const guest = { id: 1, name: "Guest", guest: true } as Profile;

  beforeEach(() => {
    mocks.library.mockResolvedValue([]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");
    mocks.current.mockResolvedValue(guest);
    mocks.addons.mockResolvedValue([]);
    mocks.visibleAddons.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explains addons on a fresh install, with the manager a click away", async () => {
    await renderApp("/");

    const region = await empty();
    expect(region).toHaveTextContent("Peli comes with no addons");
    expect(screen.queryByText("Titles you save and watch show up here.")).toBeNull();
    // No content links: the only way out is to the addon manager.
    expect(
      within(region)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/addons"]);
  });

  it("installs an addon from Home", async () => {
    const torrentio = {
      id: "com.example.torrentio",
      name: "Torrentio",
      version: "0.0.15",
      types: ["movie"],
      resources: ["stream"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(torrentio))),
    );
    const user = userEvent.setup();
    await renderApp("/");

    await user.click(within(await empty()).getByRole("button", { name: "Install addon" }));
    const dialog = await screen.findByRole("dialog", { name: "Install an addon" });
    await user.type(within(dialog).getByLabelText("Address"), "https://torrentio.example");
    await user.keyboard("{Enter}");
    await user.click(await within(dialog).findByRole("button", { name: "Install" }));

    expect(mocks.installAddon).toHaveBeenCalledWith(1, {
      url: "https://torrentio.example/manifest.json",
      name: "Torrentio",
      enabled: true,
    });
    expect(await screen.findByText("Installed Torrentio")).toBeInTheDocument();
  });

  it("stays above the library and Continue Watching", async () => {
    mocks.library.mockResolvedValue([dune]);
    await renderApp("/");

    expect(await empty()).toBeInTheDocument();
    expect(await row("Your library")).toBeInTheDocument();
  });

  it("says when every addon is turned off", async () => {
    mocks.addons.mockResolvedValue([{ ...cinemeta, enabled: false }]);
    await renderApp("/");

    const region = await screen.findByRole("region", { name: "Your addons are turned off" });
    expect(within(region).getByRole("link", { name: "Manage addons" })).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Install addon" })).toBeNull();
  });

  it("sends a kids profile to its parent", async () => {
    // Its PIN gate is the launch gate's (#25); here it is already past it.
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.addons.mockResolvedValue([cinemeta]);
    await renderApp("/");

    const region = await screen.findByRole("region", {
      name: "Nothing chosen for this profile yet",
    });
    expect(region).toHaveTextContent("A parent chooses");
    expect(within(region).queryByRole("button", { name: "Install addon" })).toBeNull();
  });
});

describe("offline indicator", () => {
  it("checks again when clicked and goes away once back online", async () => {
    const user = userEvent.setup();
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("offline");
    mocks.checkConnection.mockResolvedValueOnce("offline").mockResolvedValueOnce("online");

    await renderApp("/");
    const indicator = await screen.findByRole("button", { name: /^Offline\./ });

    await user.click(indicator);
    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /^Offline\./ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Offline\./ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Offline\./ })).toBeNull());
  });

  it("follows Go's connection events, and checks when the webview goes online", async () => {
    mocks.library.mockResolvedValue([dune]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");
    mocks.checkConnection.mockReset().mockResolvedValue("online");

    await renderApp("/");
    await row("Your library");
    expect(screen.queryByRole("button", { name: /^Offline\./ })).toBeNull();

    mocks.handlers.get("sync:connection")?.({ data: "unavailable" });
    expect(await screen.findByRole("button", { name: /^Nuvio is down\./ })).toBeInTheDocument();

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Nuvio is down\./ })).toBeNull(),
    );
  });
});
