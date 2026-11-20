import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile, Progress } from "@bindings/store";
import { metaQuery } from "@/lib/addon-protocol";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { parseManifest, parseMetaResponse } from "@/lib/addon-protocol/parse";
import { renderApp } from "@/test/render-app";

// Each profile's library, kept in memory so removing and undoing behave as
// Go's store would.
const db = vi.hoisted(() => ({
  library: new Map<number, LibraryItem[]>(),
  lastWatched: new Map<number, Record<string, number>>(),
}));

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  library: vi.fn<(id: number) => Promise<LibraryItem[]>>(),
  lastWatched: vi.fn<(id: number) => Promise<Record<string, number>>>(),
  continueWatching: vi.fn<(id: number) => Promise<Progress[]>>(),
  save: vi.fn<(id: number, item: LibraryItem) => Promise<void>>(),
  remove: vi.fn<(id: number, contentId: string, type: string) => Promise<void>>(),
  visibleAddons: vi.fn<() => Promise<Addon[]>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: () => Promise.resolve([]),
    VisibleAddons: mocks.visibleAddons,
    Library: mocks.library,
    LastWatched: mocks.lastWatched,
    ContinueWatching: mocks.continueWatching,
    SaveLibraryItem: mocks.save,
    RemoveLibraryItem: mocks.remove,
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

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;
const mj = { id: 2, name: "MJ", nuvioIndex: 2 } as Profile;

const item = (contentId: string, contentType: string, name: string, addedAt: number) =>
  ({ contentId, contentType, name, addedAt, releaseInfo: "2008" }) as LibraryItem;

const breakingBad = item("tt0903747", "series", "Breaking Bad", 40);
const frieren = item("kitsu:46474", "anime", "Frieren", 30);
const heat = item("tt0113277", "movie", "Heat", 20);
const alien = item("tt0078748", "movie", "Alien", 10);

const grid = () => screen.findByRole("listbox", { name: "Library" });
// Cards mount once the grid has measured its scroll container. A card with
// no art also prints its name on the artwork, so read the caption's.
const titles = async () =>
  (await within(await grid()).findAllByRole("button")).map(
    (card) => card.lastElementChild?.firstElementChild?.textContent,
  );
const card = async (name: string) =>
  within(await grid()).findByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  db.library.set(kevin.id, [breakingBad, frieren, heat, alien]);
  db.lastWatched.set(kevin.id, { [alien.contentId]: 500, [frieren.contentId]: 400 });
  mocks.current.mockResolvedValue(kevin);
  mocks.visibleAddons.mockResolvedValue([]);
  // The store's order: most recently added first.
  mocks.library.mockImplementation((id) =>
    Promise.resolve((db.library.get(id) ?? []).toSorted((a, b) => b.addedAt - a.addedAt)),
  );
  mocks.continueWatching.mockResolvedValue([]);
  mocks.lastWatched.mockImplementation((id) => Promise.resolve(db.lastWatched.get(id) ?? {}));
  mocks.save.mockImplementation((id, saved) => {
    db.library.set(id, [...(db.library.get(id) ?? []), saved]);
    return Promise.resolve();
  });
  mocks.remove.mockImplementation((id, contentId) => {
    db.library.set(
      id,
      (db.library.get(id) ?? []).filter((i) => i.contentId !== contentId),
    );
    return Promise.resolve();
  });
  // Offline: nothing on the page needs the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("offline"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.library.clear();
  db.lastWatched.clear();
});

describe("library page", () => {
  it("shows the library offline, most recently added first", async () => {
    await renderApp("/library");

    expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(await titles()).toEqual(["Breaking Bad", "Frieren", "Heat", "Alien"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the episode a show in progress is on beside its year", async () => {
    mocks.continueWatching.mockResolvedValue([
      {
        key: "",
        contentId: breakingBad.contentId,
        contentType: "series",
        videoId: "tt0903747:5:3",
        season: 5,
        episode: 3,
        position: 1000,
        duration: 3000,
        lastWatched: 1,
      },
    ]);
    await renderApp("/library");
    await waitFor(async () =>
      expect(await card("Breaking Bad")).toHaveTextContent("2008 · S5 · E3"),
    );
    // A title nobody is partway through has only its year.
    expect(await card("Heat")).not.toHaveTextContent("S5");
  });

  it("filters by type, keeping the choice in the address", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/library");
    await grid();
    const types = screen.getByRole("group", { name: "Type" });
    expect(
      within(types)
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["All", "Movies", "Shows", "Anime"]);

    await user.click(within(types).getByRole("button", { name: "Movies" }));
    await waitFor(async () => expect(await titles()).toEqual(["Heat", "Alien"]));
    expect(router.state.location.search).toEqual({ type: "movie" });

    await user.click(within(types).getByRole("button", { name: "All" }));
    await waitFor(async () => expect(await titles()).toHaveLength(4));
    expect(router.state.location.search).toEqual({});
  });

  it("has no type filter when the library holds one type", async () => {
    db.library.set(kevin.id, [heat, alien]);
    await renderApp("/library");
    await grid();
    expect(screen.queryByRole("group", { name: "Type" })).toBeNull();
  });

  it("sorts by recently watched and A–Z", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/library");
    await grid();
    const sort = screen.getByRole("combobox", { name: "Sort" });
    expect(sort).toHaveTextContent("Recently added");

    await user.click(sort);
    await user.click(await screen.findByRole("option", { name: "Recently watched" }));
    // Never watched: last, most recently added first.
    await waitFor(async () =>
      expect(await titles()).toEqual(["Alien", "Frieren", "Breaking Bad", "Heat"]),
    );
    expect(router.state.location.search).toEqual({ sort: "watched" });

    await user.click(sort);
    await user.click(await screen.findByRole("option", { name: "A–Z" }));
    await waitFor(async () =>
      expect(await titles()).toEqual(["Alien", "Breaking Bad", "Frieren", "Heat"]),
    );
  });

  it("opens the address's filter and sort", async () => {
    await renderApp("/library?type=movie&sort=name");
    expect(await titles()).toEqual(["Alien", "Heat"]);
  });

  it("opens a title from its card", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/library");
    await user.click(await card("Heat"));
    expect(router.state.location.pathname).toBe("/title/movie/tt0113277");
  });

  it("removes a title from the card's context menu, with Undo", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    fireEvent.contextMenu(await card("Heat"));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));

    expect(mocks.remove).toHaveBeenCalledWith(kevin.id, "tt0113277", "movie");
    await waitFor(async () => expect(await titles()).toEqual(["Breaking Bad", "Frieren", "Alien"]));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(mocks.save).toHaveBeenCalledWith(kevin.id, heat);
    await waitFor(async () => expect(await titles()).toHaveLength(4));
    expect(await titles()).toEqual(["Breaking Bad", "Frieren", "Heat", "Alien"]);
  });

  it("removes the focused title with Delete", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    (await card("Frieren")).focus();
    await user.keyboard("{Delete}");
    expect(mocks.remove).toHaveBeenCalledWith(kevin.id, "kitsu:46474", "anime");
    await waitFor(async () => expect(await titles()).toEqual(["Breaking Bad", "Heat", "Alien"]));
    // The title that took its place has the focus.
    await waitFor(async () => expect(await card("Heat")).toHaveFocus());
  });

  it("says when the library is empty", async () => {
    db.library.set(kevin.id, []);
    await renderApp("/library");
    expect(
      await screen.findByRole("heading", { name: "Your library is empty" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse movies" })).toHaveAttribute("href", "/movies");
  });

  it("follows a profile switch", async () => {
    db.library.set(mj.id, [item("tt0068646", "movie", "The Godfather", 1)]);
    const { queryClient } = await renderApp("/library");
    expect(await titles()).toHaveLength(4);

    mocks.current.mockResolvedValue(mj);
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await waitFor(async () => expect(await titles()).toEqual(["The Godfather"]), { timeout: 3000 });
  });
});

// Upcoming (#48): two shows from two addons, with episodes dated from today.
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
const breakingBadUrl = "https://v3-cinemeta.strem.io/meta/series/tt0903747.json";
const frierenUrl = "https://anime-kitsu.strem.fun/meta/anime/kitsu%3A46474.json";

// Noon, `days` days from today, in local time.
const day = (days: number) => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, 12);
};
const episode = (id: string, season: number, number: number, released: Date) => ({
  id: `${id}:${season}:${number}`,
  name: `Episode ${number}`,
  season,
  episode: number,
  released: released.toISOString(),
});
const metas = {
  [breakingBadUrl]: {
    meta: {
      id: "tt0903747",
      type: "series",
      name: "Breaking Bad",
      videos: [
        episode("tt0903747", 5, 1, day(-1)),
        episode("tt0903747", 5, 2, day(3)),
        episode("tt0903747", 5, 3, day(60)),
      ],
    },
  },
  [frierenUrl]: {
    meta: {
      id: "kitsu:46474",
      type: "series",
      name: "Frieren",
      videos: [episode("kitsu:46474", 2, 1, day(1)), episode("kitsu:46474", 2, 2, day(40))],
    },
  },
};

// Answers the addons by URL; anything else fails.
function serve(answers: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [kitsu.url]: kitsuManifest,
    ...answers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url in all ? Response.json(all[url]) : new Response("", { status: 503 }),
    ),
  );
}

const section = (name: string) => screen.findByRole("region", { name });
const entries = async (name: string) =>
  within(await section(name))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

describe("upcoming episodes", () => {
  beforeEach(() => {
    mocks.visibleAddons.mockResolvedValue([cinemeta, kitsu]);
  });

  it("lists the library shows' episodes from today by day, from the Upcoming tab", async () => {
    serve(metas);
    // Clicks don't register on Base UI tabs in jsdom (neither user-event's
    // nor fireEvent's), so the view is opened by its address.
    await renderApp("/library?sort=name&view=upcoming");
    const upcoming = await screen.findByRole("tab", { name: "Upcoming" });
    await waitFor(() => expect(upcoming).toHaveAttribute("aria-selected", "true"));

    expect(await entries("Tomorrow")).toEqual(["Frieren, S2 · E1: Episode 1"]);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(day(3));
    expect(await entries(weekday)).toEqual(["Breaking Bad, S5 · E2: Episode 2"]);
    // Both shows have an episode this month, so Later has nothing to add,
    // and yesterday's episode is gone.
    expect(screen.queryByRole("region", { name: "Later" })).toBeNull();
    expect(screen.queryByText(/S5 · E1/)).toBeNull();
    expect(screen.queryByText(/Checking/)).toBeNull();
  });

  it("shows when a day's episode airs, at the end of its row", async () => {
    serve(metas);
    await renderApp("/library?view=upcoming");
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(day(1));
    const [row] = within(await section("Tomorrow")).getAllByRole("button");
    expect(row?.lastElementChild).toHaveTextContent(time);
  });

  it("shows each show's next episode past four weeks under Later", async () => {
    const [bbMeta, frierenMeta] = [metas[breakingBadUrl], metas[frierenUrl]];
    serve({
      [breakingBadUrl]: { meta: { ...bbMeta.meta, videos: bbMeta.meta.videos.slice(2) } },
      [frierenUrl]: { meta: { ...frierenMeta.meta, videos: frierenMeta.meta.videos.slice(1) } },
    });
    await renderApp("/library?view=upcoming");
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
    expect(await entries("Later")).toEqual([
      `Frieren, S2 · E2: Episode 2, ${date.format(day(40))}`,
      `Breaking Bad, S5 · E3: Episode 3, ${date.format(day(60))}`,
    ]);
  });

  it("puts a show's episodes on the same day in one entry", async () => {
    const bbMeta = metas[breakingBadUrl];
    serve({
      ...metas,
      [breakingBadUrl]: {
        meta: {
          ...bbMeta.meta,
          // All four out tomorrow.
          videos: [1, 2, 3, 4].map((number) => episode("tt0903747", 5, number, day(1))),
        },
      },
    });
    await renderApp("/library?view=upcoming");
    expect(await entries("Tomorrow")).toEqual([
      "Breaking Bad, S5 · E1–E4: 4 episodes",
      "Frieren, S2 · E1: Episode 1",
    ]);
  });

  it("opens the show on the episode's season", async () => {
    serve(metas);
    const user = userEvent.setup();
    const { router } = await renderApp("/library?view=upcoming");
    await user.click(await within(await section("Tomorrow")).findByRole("button"));
    expect(decodeURIComponent(router.state.location.pathname)).toBe("/title/anime/kitsu:46474");
    expect(router.state.location.search).toEqual({ season: 2 });
  });

  it("paints from cached details offline", async () => {
    await renderApp("/library?view=upcoming", {
      seed: (client) => {
        client.setQueryData(manifestKey(cinemeta), parseManifest(cinemetaManifest));
        client.setQueryData(manifestKey(kitsu), parseManifest(kitsuManifest));
        client.setQueryData(
          metaQuery(cinemeta.url, "series", "tt0903747").queryKey,
          parseMetaResponse(metas[breakingBadUrl]),
        );
        client.setQueryData(
          metaQuery(kitsu.url, "anime", "kitsu:46474").queryKey,
          parseMetaResponse(metas[frierenUrl]),
        );
      },
    });
    expect(await entries("Tomorrow")).toEqual(["Frieren, S2 · E1: Episode 1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says which shows couldn't be checked, and tries them again", async () => {
    serve({ [breakingBadUrl]: metas[breakingBadUrl] });
    const user = userEvent.setup();
    await renderApp("/library?view=upcoming");
    expect(
      await screen.findByText("Couldn’t check one show.", {}, { timeout: 3000 }),
    ).toBeVisible();
    expect(await screen.findByRole("button", { name: /^Breaking Bad, S5 · E2/ })).toBeVisible();

    serve(metas);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await entries("Tomorrow")).toEqual(["Frieren, S2 · E1: Episode 1"]);
    expect(screen.queryByText(/Couldn’t check/)).toBeNull();
  });

  it("says when nothing is coming up", async () => {
    serve({
      [breakingBadUrl]: { meta: { ...metas[breakingBadUrl].meta, videos: [] } },
      [frierenUrl]: { meta: { ...metas[frierenUrl].meta, videos: [] } },
    });
    await renderApp("/library?view=upcoming");
    expect(await screen.findByRole("heading", { name: "Nothing coming up" })).toBeInTheDocument();
  });

  it("says when the library has no shows", async () => {
    db.library.set(kevin.id, [heat, alien]);
    await renderApp("/library?view=upcoming");
    expect(
      await screen.findByRole("heading", { name: "No shows in your library" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse shows" })).toHaveAttribute("href", "/shows");
  });
});

const manifestKey = (addon: Addon) => ["addon-manifest", addon.url];
