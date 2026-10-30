import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, Profile } from "@bindings/store";
import type { Request, Source } from "@bindings/streams";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "@/lib/addon-protocol/fixtures/cinemeta/meta-series.json";
import peerflixManifest from "@/lib/addon-protocol/fixtures/peerflix/manifest.json";
import peerflixMovie from "@/lib/addon-protocol/fixtures/peerflix/stream-movie.json";
import torrentioManifest from "@/lib/addon-protocol/fixtures/torrentio/manifest.json";
import torrentioSeries from "@/lib/addon-protocol/fixtures/torrentio/stream-series.json";
import { renderApp } from "@/test/render-app";

const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  addons: vi.fn<() => Promise<Addon[]>>(),
  visibleAddons: vi.fn<() => Promise<Addon[] | null>>(),
  resolve: vi.fn<(request: Request) => Promise<Source>>(),
  cancel: vi.fn<() => void>(),
  load: vi.fn<(source: Source, opts: { start: number }) => Promise<void>>(),
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    Addons: mocks.addons,
    VisibleAddons: mocks.visibleAddons,
    CatalogVisible: () => Promise.resolve(true),
    HomeLayout: () => Promise.resolve(null),
    Collections: () => Promise.resolve([]),
    ContinueWatching: () => Promise.resolve([]),
    Library: () => Promise.resolve([]),
    TitleWatched: () => Promise.resolve([]),
    TitleProgress: () => Promise.resolve([]),
    ProfileSettings: () =>
      Promise.resolve({
        audioLanguage: "",
        subtitleLanguage: "",
        subtitleSize: "medium",
        captions: "system",
      }),
  },
}));

// A Wails call: a promise with cancel.
vi.mock("@bindings/streams", () => ({
  Service: {
    Resolve: (request: Request) => Object.assign(mocks.resolve(request), { cancel: mocks.cancel }),
  },
}));

vi.mock("@bindings/player", () => ({
  Service: {
    Load: mocks.load,
    Snapshot: () => Promise.reject(new Error("not playing")),
    Stop: () => Promise.resolve(),
    SetPaused: () => Promise.resolve(),
    SetFullscreen: () => Promise.resolve(),
  },
}));

// The player screen, once a picked stream is loaded.
const opensThePlayer = async () =>
  expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();

vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

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
const torrentio: Addon = {
  url: "https://torrentio.strem.fun/manifest.json",
  name: "Torrentio",
  enabled: true,
};
const peerflix: Addon = {
  url: "https://peerflix.example/manifest.json",
  name: "Peerflix",
  enabled: true,
};

const movieStreams = (addon: string) => `https://${addon}/stream/movie/tt0111161.json`;
const pickerPath = "/streams/movie/tt0111161";

// An answer made afresh for each request.
class Each {
  constructor(readonly make: () => unknown) {}
}

// Answers addon requests by full URL: a body, a promise of one for an addon
// that answers when the test says, or Each. Anything else answers 503.
// Returns each request's URL and signal.
function serve(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    [cinemeta.url]: cinemetaManifest,
    [torrentio.url]: torrentioManifest,
    [peerflix.url]: peerflixManifest,
    "https://v3-cinemeta.strem.io/meta/movie/tt0111161.json": cinemetaMovie,
    "https://v3-cinemeta.strem.io/meta/series/tt0903747.json": cinemetaSeries,
    ...answers,
  };
  const fetch = vi.fn<(url: string, init: { signal: AbortSignal }) => Promise<Response>>(
    async (url, init) => {
      if (!(url in all)) return new Response("", { status: 503 });
      const answer = all[url];
      const body = await Promise.race([
        answer instanceof Each ? answer.make() : answer,
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
      ]);
      return Response.json(body);
    },
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.map(([url, init]) => ({ url, signal: init.signal }));
}

function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const streams = (count: number) => ({
  streams: Array.from({ length: count }, (_, i) => ({
    name: `Source\n${i}`,
    description: `Stream.${i}.mkv`,
    url: `https://debrid.example/KEY/${i}`,
  })),
});

// A Torrentio debrid stream: cached ("+") or not (" download").
const debrid = (file: string, marker: string) => ({
  name: `[TB${marker}] Torrentio\n1080p`,
  title: `${file}\n👤 20 💾 2.1 GB ⚙️ Tracker`,
  url: `https://torrentio.strem.fun/resolve/torbox/KEY/${marker === "+" ? "a" : "b"}${"0".repeat(39)}/null/0/${file}`,
});

const addonStatus = (name: string) =>
  within(screen.getByRole("list", { name: "Addons" })).getByRole("listitem", { name });
// The streams' own buttons: not group headings, not "File name".
const shownStreams = () =>
  within(screen.getByRole("list", { name: "Streams" }))
    .queryAllByRole("button")
    .filter((button) => !button.hasAttribute("aria-expanded"));
const topPick = () => shownStreams()[0]!;

const resolved = ({ url }: Request): Source => ({
  url: `${url}#cdn`,
  origin: url,
  headers: {},
  userAgent: "Sinag/test",
  contentType: "video/x-matroska",
  size: 2_100_000_000,
});

beforeEach(() => {
  mocks.resolve.mockImplementation(async (request) => resolved(request));
  mocks.load.mockResolvedValue(undefined);
  mocks.current.mockResolvedValue(kevin);
  mocks.addons.mockResolvedValue([cinemeta, torrentio, peerflix]);
  mocks.visibleAddons.mockResolvedValue([cinemeta, torrentio, peerflix]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream picker", () => {
  it("opens from Play and asks every stream addon at once, showing each as it answers", async () => {
    const slow = later<unknown>();
    const asked = serve({
      [movieStreams("torrentio.strem.fun")]: slow.promise,
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/title/movie/tt0111161");

    await user.click(await screen.findByRole("button", { name: "Play" }));
    expect(router.state.location.pathname).toBe(pickerPath);
    expect(
      await screen.findByRole("heading", { level: 1, name: "The Shawshank Redemption" }),
    ).toBeInTheDocument();

    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("12 streams"));
    expect(addonStatus("Torrentio")).toHaveTextContent("Asking…");
    // Peerflix sends one file twice: the count is after de-duplication (#51).
    expect(
      await screen.findByText(/11 streams, 1 of 2 addons still answering/),
    ).toBeInTheDocument();
    expect(shownStreams()).not.toHaveLength(0);
    // Both were asked before either answered; Cinemeta serves no streams.
    const streamUrls = asked()
      .map(({ url }) => url)
      .filter((url) => url.includes("/stream/"));
    expect(streamUrls.toSorted()).toEqual([
      movieStreams("peerflix.example"),
      movieStreams("torrentio.strem.fun"),
    ]);

    slow.resolve(streams(3));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("3 streams"));
    expect(await screen.findByText("14 streams from 2 addons")).toBeInTheDocument();
    // Torrentio's say nothing of their quality, so they rank last, in the
    // order they came.
    expect(screen.getByRole("heading", { name: "Unknown 3" })).toBeInTheDocument();
    expect(shownStreams().at(-1)).toHaveTextContent(/^Unknown qualityTorrentio$/);
  });

  it("isn't done while an addon's manifest is still loading", async () => {
    const manifest = later<unknown>();
    serve({
      [torrentio.url]: manifest.promise,
      [movieStreams("torrentio.strem.fun")]: streams(2),
      [movieStreams("peerflix.example")]: streams(1),
    });
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Peerflix")).toHaveTextContent("1 stream"));
    expect(await screen.findByText("1 stream, still loading addons")).toBeInTheDocument();

    manifest.resolve(torrentioManifest);
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("2 streams"));
    expect(await screen.findByText("3 streams from 2 addons")).toBeInTheDocument();
  });

  it("asks for the episode, and the heading names it", async () => {
    const asked = serve({
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": torrentioSeries,
    });
    const user = userEvent.setup();
    await renderApp("/title/series/tt0903747");

    await user.click(await screen.findByRole("button", { name: /^S1 · E1/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Breaking Bad S1 · E1" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("12 streams"));
    expect(asked().filter(({ url }) => url.includes("/stream/"))).toHaveLength(2);
  });

  it("shows a failed addon's reason and asks it again on Try again", async () => {
    const asked = serve({ [movieStreams("peerflix.example")]: peerflixMovie });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("answered 503"));
    expect(addonStatus("Peerflix")).toHaveTextContent("12 streams");

    serve({
      [movieStreams("torrentio.strem.fun")]: streams(2),
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    await user.click(within(addonStatus("Torrentio")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("2 streams"));
    expect(await screen.findByText("13 streams from 2 addons")).toBeInTheDocument();
    expect(asked().filter(({ url }) => url.includes("peerflix.example/stream"))).toHaveLength(1);
  });

  it("aborts the requests still out when the picker is left", async () => {
    const asked = serve({
      [movieStreams("torrentio.strem.fun")]: later().promise,
      [movieStreams("peerflix.example")]: later().promise,
    });
    const user = userEvent.setup();
    const { router } = await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(asked().filter(({ url }) => url.includes("/stream/"))).toHaveLength(2),
    );
    const requests = asked().filter(({ url }) => url.includes("/stream/"));
    expect(requests.some(({ signal }) => signal.aborted)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt0111161"));
    await waitFor(() => expect(requests.every(({ signal }) => signal.aborted)).toBe(true));
  });

  it("lists a big answer without mounting every stream", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1400) });
    mocks.addons.mockResolvedValue([torrentio]);
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1400 streams"));
    await waitFor(() => expect(shownStreams().length).toBeGreaterThan(0));
    expect(shownStreams().length).toBeLessThan(50);
    // Stream URLs carry the debrid key: never shown.
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("ranks the streams with the top pick first and likely fakes collapsed", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [
          debrid("The.Shawshank.Redemption.1994.720p.BluRay.x264-GRP.mkv", " download"),
          debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+"),
        ],
      },
      // Peerflix answers with Dune's streams: the wrong year for this film.
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const fakes = await screen.findByRole("button", { name: /^Likely fake 8/ });
    expect(fakes).toHaveAttribute("aria-expanded", "false");
    // Cached on debrid first, as the top pick, though it's not the best
    // picture.
    expect(topPick()).toHaveTextContent(/^Top pick1080pBlu-ray/);
    expect(topPick()).toHaveTextContent("Cached · TorBox");
    expect(shownStreams()).toHaveLength(5);

    await user.click(fakes);
    expect(fakes).toHaveAttribute("aria-expanded", "true");
    expect(shownStreams()).toHaveLength(13);
    expect(screen.getAllByText("Another year’s release")).toHaveLength(8);
    await user.click(fakes);
    expect(shownStreams()).toHaveLength(5);
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("asks every enabled addon, even ones a kids profile doesn't browse", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    mocks.visibleAddons.mockResolvedValue([cinemeta]);
    mocks.addons.mockResolvedValue([cinemeta, torrentio, { ...peerflix, enabled: false }]);
    const asked = serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    await renderApp(pickerPath);

    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1 stream"));
    expect(screen.queryByRole("listitem", { name: "Peerflix" })).toBeNull();
    expect(asked().some(({ url }) => url.includes("peerflix"))).toBe(false);
  });

  it("says so when no addon serves streams for the title", async () => {
    mocks.addons.mockResolvedValue([cinemeta]);
    serve();
    await renderApp(pickerPath);

    expect(
      await screen.findByRole("heading", { name: "No addon has streams for this" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage addons" })).toBeInTheDocument();
  });

  it("resolves a picked stream's link and plays it", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [
          {
            ...streams(1).streams[0],
            behaviorHints: { proxyHeaders: { request: { Referer: "https://addon.example/" } } },
          },
        ],
      },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    await opensThePlayer();
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      url: "https://debrid.example/KEY/0",
      headers: { Referer: "https://addon.example/" },
    });
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(await mocks.resolve.mock.results[0]!.value, {
      start: 0,
    });
    // Named from the title's details, not the picker's fallback heading.
    expect(screen.getByRole("heading", { name: "The Shawshank Redemption" })).toBeInTheDocument();
  });

  it("says so when the player can't start", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.load.mockRejectedValue(new Error("call failed", { cause: { code: "unavailable" } }));
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    expect(await screen.findByText("Can’t play Streams")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("says why a stream won't play, naming its debrid service", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", " download")],
      },
    });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockRejectedValue(new Error("call failed", { cause: { code: "caching" } }));
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Not cached · TorBox"));
    await user.click(topPick());
    expect(await screen.findByText("TorBox is still downloading this")).toBeInTheDocument();
    expect(screen.getByText(/Pick a cached stream to watch now/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("KEY");
  });

  it("asks the addon again for a link that has expired", async () => {
    let asked = 0;
    serve({
      [movieStreams("torrentio.strem.fun")]: new Each(() => {
        asked += 1;
        return {
          streams: [
            {
              ...debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+"),
              url: `https://torrentio.strem.fun/resolve/torbox/KEY/link-${asked}`,
            },
          ],
        };
      }),
    });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockImplementation(async (request) => {
      if (request.url.endsWith("link-1")) {
        throw new Error("call failed", { cause: { code: "expired" } });
      }
      return resolved(request);
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await user.click(topPick());
    await opensThePlayer();
    expect(mocks.resolve.mock.calls.map(([request]) => request.url)).toEqual([
      "https://torrentio.strem.fun/resolve/torbox/KEY/link-1",
      "https://torrentio.strem.fun/resolve/torbox/KEY/link-2",
    ]);
  });

  it("stops resolving when the picker is left", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    mocks.resolve.mockReturnValue(later<Source>().promise);
    const user = userEvent.setup();
    const { router } = await renderApp("/title/movie/tt0111161");
    await user.click(await screen.findByRole("button", { name: "Play" }));

    await waitFor(() => expect(shownStreams()).toHaveLength(1));
    await user.click(topPick());
    expect(await screen.findByText("Opening the stream from Torrentio…")).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/title/movie/tt0111161"));
    expect(mocks.cancel).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByText("Opening the stream from Torrentio…")).toBeNull(),
    );
  });

  it("plays the top pick with P, from anywhere on the picker", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+")],
      },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    await user.keyboard("p");
    await opensThePlayer();
    // Torrentio's cached 1080p, not Peerflix's torrent.
    expect(mocks.resolve.mock.calls[0]![0].url).toMatch(
      /^https:\/\/torrentio\.strem\.fun\/resolve\/torbox\//,
    );
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("shows a stream's file name only when asked", async () => {
    const file = "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv";
    serve({ [movieStreams("torrentio.strem.fun")]: { streams: [debrid(file, "+")] } });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    expect(screen.queryByText(file)).toBeNull();
    const button = within(screen.getByRole("list", { name: "Streams" })).getByRole("button", {
      name: "File name",
    });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(file)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("KEY");

    // I, on the row, hides it again.
    topPick().focus();
    await user.keyboard("i");
    expect(screen.queryByText(file)).toBeNull();
  });

  it("moves through the list with the arrow keys, Home and End, and plays with Enter", async () => {
    serve({
      [movieStreams("torrentio.strem.fun")]: {
        streams: [debrid("The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv", "+")],
      },
      [movieStreams("peerflix.example")]: peerflixMovie,
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("Cached · TorBox"));
    // The list is one Tab stop, at the top pick.
    const list = screen.getByRole("list", { name: "Streams" });
    const stop = within(list)
      .getAllByRole("button")
      .find((button) => button.tabIndex === 0);
    expect(stop).toBe(topPick());

    topPick().focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(shownStreams()[1]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(topPick());
    // End reaches the collapsed group's heading; Enter opens it.
    await user.keyboard("{End}");
    const fakes = screen.getByRole("button", { name: /^Likely fake 8/ });
    expect(document.activeElement).toBe(fakes);
    await user.keyboard("{Enter}");
    expect(fakes).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(topPick());
    await user.keyboard("{Enter}");
    await opensThePlayer();
  });

  it("keeps the top pick once the user moves into the list", async () => {
    const slow = later<unknown>();
    serve({
      [movieStreams("torrentio.strem.fun")]: slow.promise,
      [movieStreams("peerflix.example")]: {
        streams: [
          {
            name: "Peerflix 1080p",
            description: "The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv\n👤 40 💾 9.6 GB",
            infoHash: "a".repeat(40),
          },
        ],
      },
    });
    const user = userEvent.setup();
    await renderApp(pickerPath);

    await waitFor(() => expect(topPick()).toHaveTextContent("P2P · 40 seeders"));
    await user.click(topPick().nextElementSibling!.querySelector("button")!);

    // A better one arrives: cached on debrid. It's listed, but below.
    slow.resolve({
      streams: [debrid("The.Shawshank.Redemption.1994.2160p.BluRay.x265-GRP.mkv", "+")],
    });
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("1 stream"));
    await waitFor(() => expect(shownStreams()).toHaveLength(2));
    expect(topPick()).toHaveTextContent("P2P · 40 seeders");
    expect(shownStreams()[1]).toHaveTextContent("Cached · TorBox");
  });
});
