import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import type * as Runtime from "@wailsio/runtime";
import { Service as Downloads, type Playable } from "@bindings/downloads";
import type { Addon, Download, LibraryItem, Profile, Progress } from "@bindings/store";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import { renderApp } from "@/test/render-app";

// Home's "Downloaded" row (#85, ADR-0064, part 9): the profile's finished
// downloads, newest first, at the top when offline, playing through usePlay
// and following the download events the shell subscribes to once.

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { data: unknown }) => void>>(),
  library: vi.fn<() => Promise<LibraryItem[]>>(),
  continueWatching: vi.fn<() => Promise<Progress[]>>(),
  // What Go says about Nuvio: "online" or "offline".
  connection: { value: "online" },
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        const listeners = mocks.handlers.get(name) ?? new Set();
        listeners.add(callback);
        mocks.handlers.set(name, listeners);
        return () => listeners.delete(callback);
      },
    },
  };
});

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

// A manifest with no catalogs: no hero and no catalog rows, so the row order
// the tests read is the rows themselves.
const manifest = { ...cinemetaManifest, catalogs: [] };

const cinemeta: Addon = {
  url: "https://v3-cinemeta.strem.io/manifest.json",
  name: "Cinemeta",
  enabled: true,
};

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([kevin]),
    CurrentProfile: () => Promise.resolve(kevin),
    Addons: () => Promise.resolve([cinemeta]),
    VisibleAddons: () => Promise.resolve([cinemeta]),
    CatalogVisible: () => Promise.resolve(true),
    Library: mocks.library,
    ContinueWatching: mocks.continueWatching,
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
  },
}));

vi.mock("@bindings/account", () => ({
  Service: {
    Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }),
    InstallAddon: () => Promise.resolve(),
  },
}));

vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: () => Promise.resolve(mocks.connection.value),
    CheckConnection: () => Promise.resolve(mocks.connection.value),
  },
}));

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

// A finished download of a film, as Go records one.
function film(fields: Partial<Download> = {}): Download {
  return {
    id: "0123456789abcdef0123456789abcdef",
    profileId: 1,
    contentId: "tt1160419",
    contentType: "movie",
    videoId: "tt1160419",
    season: 0,
    episode: 0,
    name: "Dune",
    episodeName: "",
    poster: "",
    metaAddon: cinemeta.url,
    streamSource: "https://torrentio.strem.fun/manifest.json",
    streamName: "Torrentio",
    streamDescription: "",
    resolution: "1080p",
    request: { url: "https://cdn.example/dune.mkv", headers: null },
    root: "",
    file: "0123456789abcdef0123456789abcdef/video.mkv",
    mimeType: "video/x-matroska",
    subtitles: null,
    segments: null,
    state: "done",
    reason: "",
    bytes: 2_000_000_000,
    total: 2_000_000_000,
    createdAt: 1,
    updatedAt: 2,
    doneAt: 3,
    ...fields,
  };
}

// An episode of a show, as the title page's Download adds it.
const episodeDownload = (fields: Partial<Download> = {}) =>
  film({
    id: "fedcba9876543210fedcba9876543210",
    contentId: "tt11280740",
    contentType: "series",
    videoId: "tt11280740:1:2",
    season: 1,
    episode: 2,
    name: "Severance",
    episodeName: "Half Loop",
    doneAt: 4,
    ...fields,
  });

// What a mocked binding call answers: a CancellablePromise, which carries a
// cancel() that payloads made by hand don't.
function answering<T>(value: T) {
  return CancellablePromise.resolve(value);
}

function listed(downloads: Download[]) {
  vi.mocked(Downloads.List).mockImplementation(() => answering<Download[] | null>(downloads));
}

const emit = (name: string, data: unknown) =>
  act(() => {
    for (const listener of mocks.handlers.get(name) ?? []) listener({ data });
  });

// Answers Cinemeta's manifest, and 503 for anything else. The manifest names
// no catalogs: no hero and no catalog rows, so the rows the tests read the
// order of are the rows themselves.
function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url !== cinemeta.url) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(Response.json(manifest));
    }),
  );
}

const downloaded = () => screen.findByRole("region", { name: "Downloaded" });
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

beforeEach(() => {
  mocks.handlers.clear();
  mocks.connection.value = "online";
  mocks.library.mockReset().mockResolvedValue([]);
  mocks.continueWatching.mockReset().mockResolvedValue([]);
  // Nothing downloaded for playback: a card falls through to the picker.
  vi.mocked(Downloads.Playable).mockReset();
  vi.mocked(Downloads.Playable).mockImplementation(() => answering<Playable | null>(null));
  listed([]);
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Home's downloaded row", () => {
  it("shows the finished downloads, the most recent first, and links to them all", async () => {
    listed([film(), episodeDownload()]);
    await renderApp("/");

    const row = await downloaded();
    const cards = within(row).getAllByRole("button");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Severance"),
      expect.stringContaining("Dune"),
    ]);
    // An episode says where it is; a film's card has no second line.
    expect(within(row).getByRole("button", { name: /Severance/ })).toHaveTextContent("S1 · E2");
    expect(within(row).getByRole("button", { name: /Dune/ })).not.toHaveTextContent("S1 · E2");
    expect(within(row).getByRole("link", { name: "See all" })).toHaveAttribute(
      "href",
      "/library?view=downloads",
    );
  });

  it("shows nothing while a download is still running", async () => {
    listed([film({ state: "downloading", reason: "", doneAt: 0 })]);
    await renderApp("/");
    // Home's rows are up, with nothing else to show: still no row.
    await screen.findByText("Titles you save and watch show up here.");

    expect(screen.queryByRole("region", { name: "Downloaded" })).toBeNull();
  });

  it("sits below Continue watching online", async () => {
    mocks.continueWatching.mockResolvedValue([episode]);
    listed([film()]);
    await renderApp("/");

    await downloaded();
    await waitFor(() => expect(headings()).toEqual(["Continue watching", "Downloaded"]));
  });

  // Offline the titles that play are the ones the user can reach: the row
  // comes before everything else, under the hero.
  it("moves to the top when offline", async () => {
    mocks.connection.value = "offline";
    mocks.continueWatching.mockResolvedValue([episode]);
    listed([film()]);
    await renderApp("/");

    await downloaded();
    // Offline arrives asynchronously, so wait for the row to move up.
    await waitFor(() => expect(headings()).toEqual(["Downloaded", "Continue watching"]));
  });

  it("plays a card through usePlay", async () => {
    const user = userEvent.setup();
    listed([film()]);

    const { router } = await renderApp("/");
    const row = await downloaded();
    await user.click(within(row).getByRole("button", { name: /Dune/ }));

    // usePlay asks Go for a local copy before it opens the picker.
    await waitFor(() => expect(Downloads.Playable).toHaveBeenCalledWith(1, "tt1160419"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/streams/movie/tt1160419"));
  });

  // The shell mounts useDownloadEvents once: a job that finishes while Home
  // is open puts its title in the row without a refetch.
  it("follows the download events", async () => {
    await renderApp("/");
    // Home's rows are mounted and its list asked for: nothing downloaded yet.
    await screen.findByText("Titles you save and watch show up here.");
    expect(screen.queryByRole("region", { name: "Downloaded" })).toBeNull();

    emit("downloads:changed", film());

    expect(await downloaded()).toBeInTheDocument();
  });
});
