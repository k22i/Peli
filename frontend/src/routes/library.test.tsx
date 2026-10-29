import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { LibraryItem, Profile } from "@bindings/store";
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
  save: vi.fn<(id: number, item: LibraryItem) => Promise<void>>(),
  remove: vi.fn<(id: number, contentId: string, type: string) => Promise<void>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: () => Promise.resolve([]),
    VisibleAddons: () => Promise.resolve([]),
    Library: mocks.library,
    LastWatched: mocks.lastWatched,
    SaveLibraryItem: mocks.save,
    RemoveLibraryItem: mocks.remove,
  },
}));

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

const grid = () => screen.findByRole("list", { name: "Library" });
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
  // The store's order: most recently added first.
  mocks.library.mockImplementation((id) =>
    Promise.resolve((db.library.get(id) ?? []).toSorted((a, b) => b.addedAt - a.addedAt)),
  );
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
