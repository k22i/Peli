import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Addon, Profile } from "@bindings/store";
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
  },
}));

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

// Answers addon requests by full URL: a body, or a promise of one for an
// addon that answers when the test says. Anything else answers 503. Returns
// each request's URL and signal.
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
      const body = await Promise.race([
        all[url],
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

const addonStatus = (name: string) =>
  within(screen.getByRole("list", { name: "Addons" })).getByRole("listitem", { name });
const shownStreams = () =>
  within(screen.getByRole("list", { name: "Streams" })).queryAllByRole("button");

beforeEach(() => {
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
    expect(screen.getByText(/12 streams, 1 of 2 addons still answering/)).toBeInTheDocument();
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
    expect(screen.getByText("15 streams from 2 addons")).toBeInTheDocument();
    // Torrentio's came last, so they're listed last.
    const names = shownStreams().map((button) => button.textContent);
    expect(names.at(-1)).toMatch(/^Source · 2Torrentio/);
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
    expect(screen.getByText("1 stream, still loading addons")).toBeInTheDocument();

    manifest.resolve(torrentioManifest);
    await waitFor(() => expect(addonStatus("Torrentio")).toHaveTextContent("2 streams"));
    expect(screen.getByText("3 streams from 2 addons")).toBeInTheDocument();
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
    expect(screen.getByText("14 streams from 2 addons")).toBeInTheDocument();
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
    expect(shownStreams().length).toBeGreaterThan(0);
    expect(shownStreams().length).toBeLessThan(50);
    // Stream URLs carry the debrid key: never shown.
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

  it("says the player isn't built yet when a stream is picked", async () => {
    serve({ [movieStreams("torrentio.strem.fun")]: streams(1) });
    mocks.addons.mockResolvedValue([torrentio]);
    const user = userEvent.setup();
    await renderApp(pickerPath);

    const [first] = await within(
      await screen.findByRole("list", { name: "Streams" }),
    ).findAllByRole("button");
    await user.click(first!);
    expect(await screen.findByText("Can’t play Streams yet")).toBeInTheDocument();
  });
});
