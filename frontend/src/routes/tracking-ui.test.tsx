import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, LibraryItem, Profile } from "@bindings/store";
import type { Connections, TitleRef, TitleTracking, WatchlistItem } from "@bindings/tracking";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import { renderApp } from "@/test/render-app";

// Tracking's menu items, title-page actions and Library Watchlist view. The
// store answers a library of one film; tracking is Go's, mocked here.
const mocks = vi.hoisted(() => ({
  profile: vi.fn<() => Promise<unknown>>(),
  status: vi.fn<() => Promise<unknown>>(),
  titleStatus: vi.fn<(id: number, ref: unknown) => Promise<unknown>>(),
  setStatus: vi.fn<(id: number, ref: unknown, status: string) => Promise<unknown>>(),
  setRating: vi.fn<(id: number, ref: unknown, rating: number) => Promise<unknown>>(),
  watchlist: vi.fn<(id: number) => Promise<unknown>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.profile().then((p) => [p]),
    CurrentProfile: mocks.profile,
    Addons: () => Promise.resolve([cinemeta]),
    VisibleAddons: () => Promise.resolve([cinemeta]),
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    Library: () => Promise.resolve([heat]),
    LastWatched: () => Promise.resolve({}),
    ContinueWatching: () => Promise.resolve([]),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
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

vi.mock("@bindings/tracking", () => ({
  Service: {
    Status: mocks.status,
    ImportSoon: () => Promise.resolve(),
    TitleStatus: mocks.titleStatus,
    SetStatus: mocks.setStatus,
    SetRating: mocks.setRating,
    Watchlist: mocks.watchlist,
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

const none: Connections = {
  simklAvailable: true,
  anilistAvailable: true,
  kids: false,
  simkl: null,
  anilist: null,
};
const simkl: Connections = {
  ...none,
  simkl: { user: "kevin", needsReconnect: false, importedAt: 0 },
};
const noTitle: TitleTracking = { status: "none", rating: 0, services: [], queued: false };

const planned: WatchlistItem[] = [
  {
    id: "tt0133093",
    type: "movie",
    name: "The Matrix",
    year: 1999,
    poster: "",
    ids: { imdb: "tt0133093" },
    services: ["simkl"],
  },
];

function serve() {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [`${base}/meta/movie/tt0111161.json`]: cinemetaMovie,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url in all ? Response.json(all[url]) : new Response("", { status: 503 }),
    ),
  );
}

const heatCard = () => screen.findByRole("button", { name: /Heat/ });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.profile.mockResolvedValue(kevin);
  mocks.status.mockResolvedValue(simkl);
  mocks.titleStatus.mockResolvedValue(noTitle);
  mocks.watchlist.mockResolvedValue([]);
  mocks.setStatus.mockImplementation((_, __, status) => Promise.resolve({ ...noTitle, status }));
  mocks.setRating.mockImplementation((_, __, rating) => Promise.resolve({ ...noTitle, rating }));
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tracking in the title menu", () => {
  it("offers the watchlist, a status and a rating when SIMKL is connected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());

    await user.click(await screen.findByRole("menuitem", { name: "Add to Watchlist" }));
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledTimes(1));
    const [profile, ref, status] = mocks.setStatus.mock.calls[0]!;
    expect([profile, status]).toEqual([1, "planned"]);
    expect(ref).toMatchObject({
      type: "movie",
      id: "tt0113277",
      name: "Heat",
    } satisfies Partial<TitleRef>);

    // A film has no "Watching" or "On hold" on SIMKL.
    fireEvent.contextMenu(await heatCard());
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    const radios = await screen.findAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Completed", "Dropped", "None"]);
    fireEvent.click(radios[0]!);
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenLastCalledWith(1, expect.anything(), "completed"),
    );
  });

  it("rates a title and clears the rating, and shows the current state", async () => {
    mocks.titleStatus.mockResolvedValue({ ...noTitle, status: "planned", rating: 7 });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());

    // Planned: the item takes it off.
    expect(
      await screen.findByRole("menuitem", { name: "Remove from Watchlist" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Rate…" }));
    const seven = await screen.findByRole("menuitemradio", { name: "7" });
    await waitFor(() => expect(seven).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "9" }));
    await waitFor(() => expect(mocks.setRating).toHaveBeenLastCalledWith(1, expect.anything(), 9));
    // Radio items leave the menu open: close it, submenu first.
    await user.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(screen.queryAllByRole("menu")).toHaveLength(0));

    fireEvent.contextMenu(await heatCard());
    await user.click(await screen.findByRole("menuitem", { name: "Rate…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear rating" }));
    await waitFor(() => expect(mocks.setRating).toHaveBeenLastCalledWith(1, expect.anything(), 0));
  });

  it("offers nothing with no service connected", async () => {
    mocks.status.mockResolvedValue(none);
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());
    await screen.findByRole("menuitem", { name: "Mark watched" });
    expect(screen.queryByRole("menuitem", { name: /Watchlist/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rate…" })).not.toBeInTheDocument();
  });

  it("offers nothing on a kids profile", async () => {
    mocks.status.mockResolvedValue({ ...simkl, kids: true });
    mocks.profile.mockResolvedValue({ ...kevin, kids: true });
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());
    await screen.findByRole("menuitem", { name: "Mark watched" });
    expect(screen.queryByRole("menuitem", { name: /Watchlist/ })).not.toBeInTheDocument();
    expect(mocks.titleStatus).not.toHaveBeenCalled();
  });

  it("puts the old state back and says so when Go refuses", async () => {
    mocks.setStatus.mockRejectedValue(new Error("no", { cause: { code: "unreachable" } }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = await renderApp("/library");
    fireEvent.contextMenu(await heatCard());
    await user.click(await screen.findByRole("menuitem", { name: "Add to Watchlist" }));
    expect(await screen.findByText("Can’t reach your lists")).toBeInTheDocument();
    expect(queryClient.getQueryData(["tracking", 1, "title", "movie", "tt0113277"])).toEqual(
      noTitle,
    );
  });
});

describe("removing a title while SIMKL is connected", () => {
  const onSimkl: TitleTracking = {
    status: "planned",
    rating: 0,
    services: ["simkl"],
    queued: false,
  };
  const anilistOnly: Connections = {
    ...none,
    anilist: { user: "kevin", needsReconnect: false, expires: 0, importedAt: 0 },
  };

  it("asks first from Remove from Watchlist, and Cancel sends nothing", async () => {
    mocks.titleStatus.mockResolvedValue(onSimkl);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/library");
    const card = await heatCard();
    fireEvent.contextMenu(card);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from Watchlist" }));

    // The menu has closed; the dialog is still there.
    const dialog = await screen.findByRole("alertdialog", {
      name: "Remove from your SIMKL lists?",
    });
    expect(within(dialog).getByText(/watch history for this title too/)).toBeInTheDocument();
    expect(mocks.setStatus).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.setStatus).not.toHaveBeenCalled();
    // Focus goes back to the card.
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("asks from Status > None too", async () => {
    mocks.titleStatus.mockResolvedValue({ ...onSimkl, status: "completed" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "None" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mocks.setStatus).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith(1, expect.anything(), "none"));
  });

  it("asks from the title page's On watchlist button", async () => {
    mocks.titleStatus.mockResolvedValue(onSimkl);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "On watchlist" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(mocks.setStatus).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.setStatus).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "On watchlist" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith(1, expect.anything(), "none"));
  });

  it("removes at once when only AniList holds the title", async () => {
    mocks.status.mockResolvedValue(anilistOnly);
    mocks.titleStatus.mockResolvedValue({ ...onSimkl, services: ["anilist"] });
    await renderApp("/library");
    fireEvent.contextMenu(await heatCard());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from Watchlist" }));
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith(1, expect.anything(), "none"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("tracking on the title page", () => {
  it("toggles the watchlist from a round action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Add to watchlist" }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith(1, expect.anything(), "planned"),
    );
    // Go's answer: it's on the list, so the next click takes it off.
    await user.click(await screen.findByRole("button", { name: "On watchlist" }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenLastCalledWith(1, expect.anything(), "none"),
    );
  });

  it("rates from the rating menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Rate" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "8" }));
    await waitFor(() => expect(mocks.setRating).toHaveBeenCalledWith(1, expect.anything(), 8));
    expect(await screen.findByRole("button", { name: "Your rating: 8" })).toBeInTheDocument();
  });

  it("has no tracking actions with nothing connected", async () => {
    mocks.status.mockResolvedValue(none);
    await renderApp("/title/movie/tt0111161");
    await screen.findByRole("button", { name: "Add to library" });
    expect(screen.queryByRole("button", { name: /watchlist/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rate" })).not.toBeInTheDocument();
  });
});

describe("the Library's Watchlist view", () => {
  it("lists the planned titles as cards with the shared menu", async () => {
    mocks.watchlist.mockResolvedValue(planned);
    mocks.titleStatus.mockResolvedValue({ ...noTitle, status: "planned" });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { router } = await renderApp("/library?view=watchlist");
    const matrix = await screen.findByRole("button", { name: /The Matrix/ });
    fireEvent.contextMenu(matrix);
    expect(
      await screen.findByRole("menuitem", { name: "Remove from Watchlist" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(matrix);
    expect(router.state.location.pathname).toBe("/title/movie/tt0133093");
  });

  it("has a Watchlist tab, and shows the empty list", async () => {
    // (user-event clicks on Base UI tabs don't register in jsdom here, as
    // the Upcoming tab's test finds, so the view is opened by its address.)
    await renderApp("/library?view=watchlist");
    const tabs = await screen.findByRole("tablist", { name: "View" });
    const tab = await within(tabs).findByRole("tab", { name: "Watchlist" });
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    expect(
      await screen.findByRole("heading", { name: "Your watchlist is empty" }),
    ).toBeInTheDocument();
  });

  it("explains where it comes from and links to Settings when nothing is connected", async () => {
    mocks.status.mockResolvedValue(none);
    await renderApp("/library?view=watchlist");
    expect(
      await screen.findByRole("heading", { name: "Connect SIMKL or AniList" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Tracking settings" })).toHaveAttribute(
      "href",
      "/settings?section=tracking",
    );
    expect(mocks.watchlist).not.toHaveBeenCalled();
  });

  it("says so when the lists can't be read", async () => {
    mocks.watchlist.mockRejectedValue(new Error("x", { cause: { code: "unreachable" } }));
    await renderApp("/library?view=watchlist");
    expect(
      await screen.findByRole("heading", { name: "Couldn’t load your watchlist" }),
    ).toBeInTheDocument();
  });

  it("has no Watchlist tab on a kids profile, and falls back to the titles", async () => {
    mocks.profile.mockResolvedValue({ ...kevin, kids: true });
    await renderApp("/library?view=watchlist");
    await within(await screen.findByRole("tablist", { name: "View" })).findByRole("tab", {
      name: "Titles",
    });
    expect(screen.queryByRole("tab", { name: "Watchlist" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Heat/ })).toBeInTheDocument();
    expect(mocks.watchlist).not.toHaveBeenCalled();
  });
});
