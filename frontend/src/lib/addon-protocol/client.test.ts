import { describe, expect, it, vi } from "vite-plus/test";

import {
  AddonError,
  addonBase,
  createAddonClient,
  manifestUrl,
  resourceUrl,
  type Transport,
} from "./client";
import webAppManifest from "./fixtures/aiostreams/web-app-manifest.json";
import cinemetaMovieTop from "./fixtures/cinemeta/catalog-movie-top.json";
import cinemeta from "./fixtures/cinemeta/manifest.json";
import opensubtitlesMovie from "./fixtures/opensubtitles/subtitles-movie.json";
import torrentioStreams from "./fixtures/torrentio/stream-series.json";

vi.mock("@bindings/addons", () => ({ Service: { Fetch: vi.fn<() => void>() } }));

describe("manifestUrl and addonBase", () => {
  it("find the manifest and resources from what Nuvio and Stremio store", () => {
    expect(manifestUrl("https://v3-cinemeta.strem.io/manifest.json")).toBe(
      "https://v3-cinemeta.strem.io/manifest.json",
    );
    expect(manifestUrl("https://opensubtitles-v3.strem.io")).toBe(
      "https://opensubtitles-v3.strem.io/manifest.json",
    );
    expect(manifestUrl("https://addon.example/config/")).toBe(
      "https://addon.example/config/manifest.json",
    );
    expect(manifestUrl("stremio://addon.example/manifest.json")).toBe(
      "https://addon.example/manifest.json",
    );
    expect(addonBase("https://addon.example/c0nf1g/manifest.json")).toBe(
      "https://addon.example/c0nf1g",
    );
    expect(addonBase("https://opensubtitles-v3.strem.io")).toBe(
      "https://opensubtitles-v3.strem.io",
    );
  });
});

describe("resourceUrl", () => {
  const base = "https://addon.example/manifest.json";

  it("encodes ids as Stremio does", () => {
    expect(resourceUrl(base, "stream", "series", "tt0903747:1:1")).toBe(
      "https://addon.example/stream/series/tt0903747%3A1%3A1.json",
    );
    expect(resourceUrl(base, "meta", "movie", "tt0111161")).toBe(
      "https://addon.example/meta/movie/tt0111161.json",
    );
  });

  it("puts extras in the last segment, in order", () => {
    expect(
      resourceUrl(base, "catalog", "movie", "top", { genre: "Sci-Fi & Fantasy", skip: 100 }),
    ).toBe("https://addon.example/catalog/movie/top/genre=Sci-Fi%20%26%20Fantasy&skip=100.json");
    expect(
      resourceUrl(base, "catalog", "movie", "top", { search: "dune/2", genre: undefined }),
    ).toBe("https://addon.example/catalog/movie/top/search=dune%2F2.json");
    expect(
      resourceUrl(base, "catalog", "series", "last-videos", { lastVideosIds: ["tt1", "tt2"] }),
    ).toBe(
      "https://addon.example/catalog/series/last-videos/lastVideosIds=tt1&lastVideosIds=tt2.json",
    );
    expect(resourceUrl(base, "catalog", "movie", "top", {})).toBe(
      "https://addon.example/catalog/movie/top.json",
    );
  });
});

const text = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

// A transport answering from `answers` by URL. `cors: false` makes the
// webview's fetch fail as it does without CORS headers.
function fakeTransport(
  answers: Record<string, { status?: number; body: unknown; cors?: boolean }>,
) {
  const answer = (url: string) => answers[url] ?? { status: 404, body: "not found" };
  const transport = {
    fetch: vi.fn<Transport["fetch"]>((url) => {
      const a = answer(url);
      if (a.cors === false) return Promise.reject(new TypeError("Load failed"));
      return Promise.resolve(new Response(text(a.body), { status: a.status ?? 200 }));
    }),
    fetchViaGo: vi.fn<Transport["fetchViaGo"]>((url) => {
      const a = answer(url);
      return Promise.resolve({ status: a.status ?? 200, body: text(a.body) });
    }),
  };
  return transport;
}

const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

// A transport that answers nothing until its signal aborts, like an addon
// that hangs.
function hangingTransport() {
  return {
    fetch: vi.fn<Transport["fetch"]>((_url, init) => hang(init.signal)),
    fetchViaGo: vi.fn<Transport["fetchViaGo"]>((_url, signal) => hang(signal)),
  };
}

describe("createAddonClient", () => {
  it("reads each resource through the webview", async () => {
    const transport = fakeTransport({
      "https://v3-cinemeta.strem.io/manifest.json": { body: cinemeta },
      "https://v3-cinemeta.strem.io/catalog/movie/top/skip=0.json": { body: cinemetaMovieTop },
      "https://torrentio.strem.fun/stream/series/tt0903747%3A1%3A1.json": {
        body: torrentioStreams,
      },
      "https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161/filename=a.mkv.json": {
        body: opensubtitlesMovie,
      },
    });
    const client = createAddonClient(transport);

    expect((await client.manifest("https://v3-cinemeta.strem.io")).name).toBe("Cinemeta");
    const page = await client.catalog(
      "https://v3-cinemeta.strem.io/manifest.json",
      "movie",
      "top",
      { skip: 0 },
    );
    expect(page.metas).toHaveLength(cinemetaMovieTop.metas.length);
    const { streams } = await client.streams(
      "https://torrentio.strem.fun/manifest.json",
      "series",
      "tt0903747:1:1",
    );
    expect(streams[0]?.description).toBe(torrentioStreams.streams[0]?.title);
    const { subtitles } = await client.subtitles(
      "https://opensubtitles-v3.strem.io",
      "movie",
      "tt0111161",
      {
        filename: "a.mkv",
      },
    );
    expect(subtitles[0]?.lang).toBe("eng");
    expect(transport.fetchViaGo).not.toHaveBeenCalled();
  });

  it("falls back to Go for an addon without CORS headers, and remembers it", async () => {
    const transport = fakeTransport({
      "https://nocors.example/manifest.json": { body: cinemeta, cors: false },
      "https://nocors.example/meta/movie/tt1.json": {
        body: { meta: { id: "tt1", type: "movie", name: "One" } },
      },
      "https://other.example/manifest.json": { body: cinemeta },
    });
    const client = createAddonClient(transport);

    expect((await client.manifest("https://nocors.example")).id).toBe("com.linvo.cinemeta");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetchViaGo).toHaveBeenCalledTimes(1);

    // The same origin goes straight to Go; others still use the webview.
    expect((await client.meta("https://nocors.example", "movie", "tt1")).meta.name).toBe("One");
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    await client.manifest("https://other.example");
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(transport.fetchViaGo).toHaveBeenCalledTimes(2);
  });

  it("reports an error status, even from a page without CORS headers", async () => {
    const transport = fakeTransport({
      "https://gone.example/manifest.json": { status: 404, body: "not found" },
      "https://down.example/manifest.json": { status: 502, body: "<html>", cors: false },
    });
    const client = createAddonClient(transport);

    await expect(client.manifest("https://gone.example")).rejects.toMatchObject({
      kind: "status",
      status: 404,
      message: "The addon answered 404.",
    });
    await expect(client.manifest("https://down.example")).rejects.toMatchObject({
      kind: "status",
      status: 502,
    });
  });

  it("refuses an answer that isn't the resource", async () => {
    const transport = fakeTransport({
      "https://aio.example/manifest.json": { body: webAppManifest },
      "https://aio.example/stream/movie/tt1.json": { body: "<!doctype html>" },
    });
    const client = createAddonClient(transport);

    await expect(client.manifest("https://aio.example")).rejects.toMatchObject({
      kind: "invalid",
      message: "That isn’t an addon manifest.",
    });
    await expect(client.streams("https://aio.example", "movie", "tt1")).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("says when an addon can't be reached, through either path", async () => {
    const offline = {
      fetch: vi.fn<Transport["fetch"]>(() => Promise.reject(new TypeError("Load failed"))),
      fetchViaGo: vi.fn<Transport["fetchViaGo"]>(() =>
        Promise.reject(new Error("call failed", { cause: { code: "unreachable" } })),
      ),
    };
    const error = await createAddonClient(offline)
      .manifest("https://addon.example")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AddonError);
    expect(error).toMatchObject({ kind: "unreachable", message: "The addon couldn’t be reached." });

    // Go's own timeout.
    offline.fetchViaGo.mockRejectedValueOnce(
      new Error("call failed", { cause: { code: "timeout" } }),
    );
    await expect(
      createAddonClient(offline).manifest("https://addon.example"),
    ).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("times out a request that takes too long", async () => {
    const transport = hangingTransport();
    const client = createAddonClient(transport);

    await expect(
      client.streams("https://slow.example", "movie", "tt1", { timeout: 20 }),
    ).rejects.toMatchObject({
      kind: "timeout",
      message: "The addon didn’t answer.",
    });
    // A timeout isn't a CORS failure: Go isn't asked.
    expect(transport.fetchViaGo).not.toHaveBeenCalled();
  });

  it("stops when the caller cancels, on either path", async () => {
    const transport = hangingTransport();
    const client = createAddonClient(transport);
    const controller = new AbortController();
    const request = client.streams("https://slow.example", "movie", "tt1", {
      signal: controller.signal,
    });
    const reason = new DOMException("Left the picker", "AbortError");
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);

    // Through Go: the call's signal aborts, which cancels it in Go.
    const viaGo = {
      ...hangingTransport(),
      fetch: vi.fn<Transport["fetch"]>(() => Promise.reject(new TypeError("Load failed"))),
    };
    const goController = new AbortController();
    const goRequest = createAddonClient(viaGo).manifest("https://nocors.example", {
      signal: goController.signal,
    });
    await vi.waitFor(() => expect(viaGo.fetchViaGo).toHaveBeenCalled());
    goController.abort(reason);
    await expect(goRequest).rejects.toBe(reason);
    expect(viaGo.fetchViaGo.mock.calls[0]?.[1].aborted).toBe(true);
  });
});
