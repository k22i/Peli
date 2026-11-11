import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile, Progress, WatchedItem } from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import { renderApp } from "@/test/render-app";

// The store, kept in memory so marks, progress and the library change as
// Go's would.
const db = vi.hoisted(() => ({
  watched: [] as WatchedItem[],
  progress: [] as Progress[],
  library: [] as LibraryItem[],
}));

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  setWatched: vi.fn<(id: number, items: WatchedItem[], watched: boolean) => Promise<void>>(),
  save: vi.fn<(id: number, item: LibraryItem) => Promise<void>>(),
  remove: vi.fn<(id: number, contentId: string, type: string) => Promise<void>>(),
  removeProgress: vi.fn<(id: number, key: string) => Promise<void>>(),
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
    Library: () => Promise.resolve([...db.library]),
    LastWatched: () => Promise.resolve({}),
    ContinueWatching: () => Promise.resolve([...db.progress]),
    TitleWatched: (_: number, id: string) =>
      Promise.resolve(db.watched.filter((item) => item.contentId === id)),
    TitleProgress: (_: number, id: string) =>
      Promise.resolve(db.progress.filter((entry) => entry.contentId === id)),
    SetWatched: mocks.setWatched,
    SaveLibraryItem: mocks.save,
    RemoveLibraryItem: mocks.remove,
    RemoveProgress: mocks.removeProgress,
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

const heat: LibraryItem = {
  contentId: "tt0113277",
  contentType: "movie",
  name: "Heat",
  releaseInfo: "1995",
  addedAt: 1000,
};
const base = "https://v3-cinemeta.strem.io";

// Answers addon requests by full URL; anything else answers 503.
function serve(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [`${base}/meta/movie/tt0111161.json`]: cinemetaMovie,
    ...answers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url in all ? Response.json(all[url]) : new Response("", { status: 503 }),
    ),
  );
}

const card = async (name: RegExp | string) =>
  screen.findByRole("button", { name: typeof name === "string" ? new RegExp(name) : name });
const items = async () =>
  (await screen.findAllByRole("menuitem")).map((entry) => entry.textContent);

beforeEach(() => {
  db.watched = [];
  db.progress = [];
  db.library = [heat];
  mocks.current.mockResolvedValue(kevin);
  mocks.setWatched.mockImplementation((_, written, watched) => {
    for (const item of written) {
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
  mocks.removeProgress.mockImplementation((_, key) => {
    db.progress = db.progress.filter((entry) => entry.key !== key);
    return Promise.resolve();
  });
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("title menu", () => {
  it("opens on a Home card with the title's actions", async () => {
    await renderApp("/");
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));

    expect(await items()).toEqual([
      "Play",
      "Choose a stream…",
      "Go to title",
      "Remove from Library",
      "Mark watched",
      "Copy IMDb link",
    ]);
  });

  it("marks a film watched and updates the cache", async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp("/");
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark watched" }));

    await waitFor(() => expect(mocks.setWatched).toHaveBeenCalledTimes(1));
    const [profile, written, watched] = mocks.setWatched.mock.calls[0]!;
    expect([profile, watched]).toEqual([1, true]);
    expect(written).toEqual([
      expect.objectContaining({ contentId: "tt0113277", contentType: "movie", title: "Heat" }),
    ]);
    await waitFor(() =>
      expect(queryClient.getQueryData(["watched", 1, "tt0113277"])).toHaveLength(1),
    );

    // Marked: the same menu now offers to undo it.
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark unwatched" }));
    await waitFor(() =>
      expect(mocks.setWatched).toHaveBeenLastCalledWith(1, expect.anything(), false),
    );
  });

  it("offers Resume and Remove from Continue Watching to a film in progress", async () => {
    db.progress = [
      {
        key: "tt0113277",
        contentId: "tt0113277",
        contentType: "movie",
        videoId: "tt0113277",
        position: 600_000,
        duration: 3_000_000,
        lastWatched: 5,
      },
    ];
    const user = userEvent.setup();
    const { router } = await renderApp("/");
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));

    // The progress is read when the menu opens.
    expect(await screen.findByRole("menuitem", { name: "Resume" })).toBeInTheDocument();
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove from Continue Watching" }),
    );
    expect(mocks.removeProgress).toHaveBeenCalledWith(1, "tt0113277");

    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Play" }));
    expect(router.state.location.pathname).toBe("/streams/movie/tt0113277");
  });

  it("goes to the title's page and chooses a stream", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Choose a stream…" }));
    expect(router.state.location.pathname).toBe("/streams/movie/tt0113277");

    await router.navigate({ to: "/" });
    const again = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(again).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Go to title" }));
    expect(router.state.location.pathname).toBe("/title/movie/tt0113277");
  });

  it("copies the IMDb link", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    const region = await screen.findByRole("region", { name: "Your library" });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Heat/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy IMDb link" }));
    // user-event's clipboard stands in for the system's.
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("https://www.imdb.com/title/tt0113277/"),
    );
  });

  it("adds a search result to the library", async () => {
    serve({
      [`${base}/catalog/movie/top/search=shawshank.json`]: {
        metas: [{ id: "tt0111161", type: "movie", name: "The Shawshank Redemption" }],
      },
    });
    const user = userEvent.setup();
    const { queryClient } = await renderApp("/search?q=shawshank");
    const region = await screen.findByRole("region", { name: /^Movies/ });
    fireEvent.contextMenu(await within(region).findByRole("button", { name: /Shawshank/ }));

    const add = await screen.findByRole("menuitem", { name: "Add to Library" });
    // Its details are fetched when the menu opens.
    await waitFor(() => expect(add).not.toHaveAttribute("aria-disabled", "true"));
    await user.click(add);

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ contentId: "tt0111161", contentType: "movie" }),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryData<LibraryItem[]>(["library", 1])?.map((x) => x.contentId),
      ).toContain("tt0111161"),
    );
  });

  it("removes a library title from the library's card menu", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    fireEvent.contextMenu(await card("Heat"));
    expect(await items()).toContain("Mark watched");
    await user.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));
    expect(mocks.remove).toHaveBeenCalledWith(1, "tt0113277", "movie");
  });

  it("opens from the keyboard and gives the focus back to the card", async () => {
    const user = userEvent.setup();
    await renderApp("/library");
    const heatCard = await card("Heat");

    heatCard.focus();
    fireEvent.keyDown(heatCard, { key: "ContextMenu" });
    expect(await screen.findByRole("menuitem", { name: "Go to title" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    await waitFor(() => expect(heatCard).toHaveFocus());

    fireEvent.keyDown(heatCard, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menuitem", { name: "Go to title" })).toBeInTheDocument();
  });
});
