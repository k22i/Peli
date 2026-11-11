import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { LibraryItem, Profile, WatchedItem } from "@bindings/store";
import { renderApp } from "@/test/render-app";

// The store, in memory, so marks and the library change as Go's would.
const db = vi.hoisted(() => ({ watched: [] as WatchedItem[], library: [] as LibraryItem[] }));

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  setWatched: vi.fn<(id: number, items: WatchedItem[], watched: boolean) => Promise<void>>(),
  save: vi.fn<(id: number, item: LibraryItem) => Promise<void>>(),
  remove: vi.fn<(id: number, contentId: string, type: string) => Promise<void>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: () => Promise.resolve([]),
    VisibleAddons: () => Promise.resolve([]),
    Library: () => Promise.resolve([...db.library].toSorted((a, b) => b.addedAt - a.addedAt)),
    LastWatched: () => Promise.resolve({}),
    ContinueWatching: () => Promise.resolve([]),
    TitleWatched: (_: number, id: string) =>
      Promise.resolve(db.watched.filter((item) => item.contentId === id)),
    TitleProgress: () => Promise.resolve([]),
    SetWatched: mocks.setWatched,
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
const film = (contentId: string, name: string, addedAt: number) =>
  ({ contentId, contentType: "movie", name, addedAt }) as LibraryItem;
const alien = film("tt1", "Alien", 10);
const blade = film("tt2", "Blade Runner", 20);
const casino = film("tt3", "Casino", 30);
const dune = film("tt4", "Dune", 40);

// Newest first: Dune, Casino, Blade Runner, Alien.
const card = async (name: string) =>
  within(await screen.findByRole("listbox", { name: "Library" })).findByRole("button", {
    name: new RegExp(`^${name}`),
  });
const option = async (name: string) => (await card(name)).closest("[role=option]")!;
const selection = () => screen.queryByRole("toolbar", { name: "Selection" });
const ctrlClick = async (name: string) => fireEvent.click(await card(name), { metaKey: true });

beforeEach(() => {
  db.watched = [];
  db.library = [alien, blade, casino, dune];
  mocks.current.mockResolvedValue(kevin);
  mocks.setWatched.mockImplementation((_, items, watched) => {
    for (const item of items) {
      db.watched = db.watched.filter((entry) => entry.contentId !== item.contentId);
      if (watched) db.watched.push(item);
    }
    return Promise.resolve();
  });
  mocks.save.mockImplementation((_, item) => {
    db.library.push(item);
    return Promise.resolve();
  });
  mocks.remove.mockImplementation((_, id) => {
    db.library = db.library.filter((item) => item.contentId !== id);
    return Promise.resolve();
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("offline"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("library selection", () => {
  it("toggles titles with ⌘-click and shows how many are selected", async () => {
    const { router } = await renderApp("/library");
    expect(selection()).toBeNull();

    await ctrlClick("Casino");
    await ctrlClick("Alien");
    expect(await option("Casino")).toHaveAttribute("aria-selected", "true");
    expect(await option("Alien")).toHaveAttribute("aria-selected", "true");
    expect(await option("Dune")).toHaveAttribute("aria-selected", "false");
    expect(within(selection()!).getByText("2 selected")).toBeInTheDocument();
    // A selection doesn't open anything.
    expect(router.state.location.pathname).toBe("/library");

    await ctrlClick("Casino");
    expect(within(selection()!).getByText("1 selected")).toBeInTheDocument();
  });

  it("selects a range with Shift-click, from the last one picked", async () => {
    await renderApp("/library");
    await ctrlClick("Casino");
    fireEvent.click(await card("Alien"), { shiftKey: true });

    for (const name of ["Casino", "Blade Runner", "Alien"]) {
      expect(await option(name)).toHaveAttribute("aria-selected", "true");
    }
    expect(await option("Dune")).toHaveAttribute("aria-selected", "false");
    expect(within(selection()!).getByText("3 selected")).toBeInTheDocument();

    // A plain click toggles once something is selected, rather than opening.
    const user = userEvent.setup();
    await user.click(await card("Dune"));
    expect(within(selection()!).getByText("4 selected")).toBeInTheDocument();
  });

  it("selects everything with ⌘A, and clears with Esc or Done", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    (await card("Dune")).focus();

    await user.keyboard("{Meta>}a{/Meta}");
    expect(within(selection()!).getByText("4 selected")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(selection()).toBeNull());
    expect(await option("Dune")).toHaveAttribute("aria-selected", "false");

    await user.keyboard("{Control>}a{/Control}");
    await user.click(within(selection()!).getByRole("button", { name: "Done" }));
    expect(selection()).toBeNull();
  });

  it("selects from the keyboard with Space, and Shift+Space for a range", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/library");
    (await card("Dune")).focus();
    await user.keyboard(" ");
    expect(await option("Dune")).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    await user.keyboard("{Shift>} {/Shift}");
    expect(within(selection()!).getByText("3 selected")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/library");
  });

  it("marks the selection watched, then unwatched with Undo", async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Casino");
    await user.click(within(selection()!).getByRole("button", { name: "Mark watched" }));

    await waitFor(() => expect(mocks.setWatched).toHaveBeenCalledTimes(2));
    expect(
      mocks.setWatched.mock.calls.map(([, items, watched]) => [items[0]!.title, watched]),
    ).toEqual(
      expect.arrayContaining([
        ["Alien", true],
        ["Casino", true],
      ]),
    );
    await waitFor(() => expect(queryClient.getQueryData(["watched", 1, "tt1"])).toHaveLength(1));

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.setWatched).toHaveBeenCalledTimes(4));
    expect(mocks.setWatched).toHaveBeenLastCalledWith(1, expect.anything(), false);
    expect(db.watched).toEqual([]);
  });

  it("leaves titles already in the asked state alone", async () => {
    db.watched = [{ contentId: "tt1", contentType: "movie", watchedAt: 1 }];
    const user = userEvent.setup();
    await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Casino");
    await user.click(within(selection()!).getByRole("button", { name: "Mark watched" }));
    await waitFor(() => expect(mocks.setWatched).toHaveBeenCalledTimes(1));
    expect(mocks.setWatched.mock.calls[0]![1][0]!.contentId).toBe("tt3");
  });

  it("removes the selection from the library, with Undo", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Dune");
    await user.click(within(selection()!).getByRole("button", { name: "Remove from Library" }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Alien/ })).toBeNull());
    expect(selection()).toBeNull();
    expect(await card("Casino")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(await card("Alien")).toBeInTheDocument();
  });

  it("acts on the whole selection from the menu of a card in it", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Blade Runner");

    fireEvent.contextMenu(await card("Alien"));
    expect(
      await screen.findByText("2 selected", { selector: "[role=presentation], div" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
  });

  it("gives a card outside the selection its own menu", async () => {
    await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Blade Runner");

    fireEvent.contextMenu(await card("Dune"));
    expect(await screen.findByRole("menuitem", { name: "Go to title" })).toBeInTheDocument();
  });

  it("drops a selected title the filter hides", async () => {
    const user = userEvent.setup();
    db.library = [alien, { ...film("kitsu:1", "Frieren", 50), contentType: "anime" }];
    await renderApp("/library");
    await ctrlClick("Alien");
    await ctrlClick("Frieren");
    expect(within(selection()!).getByText("2 selected")).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Anime" }),
    );
    await waitFor(() => expect(within(selection()!).getByText("1 selected")).toBeInTheDocument());
  });
});
