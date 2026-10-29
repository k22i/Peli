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

beforeEach(() => {
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
    mocks.library.mockResolvedValue([]);
    mocks.continueWatching.mockResolvedValue([]);
    mocks.connection.mockResolvedValue("online");

    await renderApp("/");

    expect(await screen.findByText("Titles you save and watch show up here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });
});

// #39: Sinag bundles no addons, so a fresh install has none. Home explains
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
    expect(region).toHaveTextContent("Sinag comes with no addons");
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
