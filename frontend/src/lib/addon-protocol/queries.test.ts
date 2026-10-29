import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";

import { createQueryClient, shouldPersistQuery } from "@/lib/query";

import { createAddonClient, type Transport } from "./client";
import cinemetaMovieTop from "./fixtures/cinemeta/catalog-movie-top.json";
import cinemeta from "./fixtures/cinemeta/manifest.json";
import torrentioStreams from "./fixtures/torrentio/stream-series.json";
import {
  catalogQuery,
  freshFor,
  manifestQuery,
  metaQuery,
  streamsQuery,
  subtitlesQuery,
} from "./queries";

vi.mock("@bindings/addons", () => ({ Service: { Fetch: vi.fn<() => void>() } }));
vi.mock("@bindings/store", () => ({ Service: {} }));

const minute = 60 * 1000;

describe("freshFor", () => {
  it("follows the addon's cacheMaxAge within limits", () => {
    expect(freshFor(undefined, minute)).toBe(minute);
    expect(freshFor({ cacheMaxAge: 0 }, minute)).toBe(minute);
    expect(freshFor({ cacheMaxAge: 14400 }, minute)).toBe(4 * 60 * minute);
    expect(freshFor({ cacheMaxAge: 5 }, 0)).toBe(minute);
    expect(freshFor({ cacheMaxAge: 30 * 24 * 3600 }, minute)).toBe(24 * 60 * minute);
  });
});

function client(answers: Record<string, unknown>) {
  const transport: Transport = {
    fetch: vi.fn<Transport["fetch"]>((url, init) => {
      const body = answers[url];
      if (body === "hang") {
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        });
      }
      return Promise.resolve(
        body ? Response.json(body) : new Response("not found", { status: 404 }),
      );
    }),
    fetchViaGo: vi.fn<Transport["fetchViaGo"]>(),
  };
  return { transport, addons: createAddonClient(transport) };
}

describe("addon queries", () => {
  it("cache what the client reads, under one key per request", async () => {
    const { transport, addons } = client({
      "https://v3-cinemeta.strem.io/manifest.json": cinemeta,
      "https://v3-cinemeta.strem.io/catalog/movie/top/genre=Drama.json": cinemetaMovieTop,
    });
    const queryClient = createQueryClient();
    const url = "https://v3-cinemeta.strem.io/manifest.json";

    expect((await queryClient.fetchQuery(manifestQuery(url, addons))).name).toBe("Cinemeta");
    await queryClient.fetchQuery(manifestQuery(url, addons));
    const catalog = catalogQuery(url, "movie", "top", { genre: "Drama" }, addons);
    await queryClient.fetchQuery(catalog);
    expect(transport.fetch).toHaveBeenCalledTimes(2);

    // Fresh for the catalog's cacheMaxAge (4 hours).
    const isStale = () => new QueryObserver(queryClient, catalog).getCurrentResult().isStale;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * minute);
      expect(isStale()).toBe(false);
      vi.setSystemTime(Date.now() + 2 * 60 * minute);
      expect(isStale()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep manifests, catalogs and metas across restarts, but never streams or subtitles", async () => {
    const { addons } = client({
      "https://v3-cinemeta.strem.io/manifest.json": cinemeta,
      "https://v3-cinemeta.strem.io/catalog/movie/top.json": cinemetaMovieTop,
      "https://v3-cinemeta.strem.io/meta/movie/tt1.json": {
        meta: { id: "tt1", type: "movie", name: "One" },
      },
      "https://torrentio.strem.fun/stream/movie/tt1.json": torrentioStreams,
      "https://subs.example/subtitles/movie/tt1.json": { subtitles: [] },
    });
    const queryClient = createQueryClient();
    const cinemetaUrl = "https://v3-cinemeta.strem.io/manifest.json";
    const manifest = manifestQuery(cinemetaUrl, addons);
    const catalog = catalogQuery(cinemetaUrl, "movie", "top", {}, addons);
    const meta = metaQuery(cinemetaUrl, "movie", "tt1", addons);
    const streams = streamsQuery("https://torrentio.strem.fun", "movie", "tt1", addons);
    const subtitles = subtitlesQuery("https://subs.example", "movie", "tt1", {}, addons);
    await Promise.all([
      queryClient.fetchQuery(manifest),
      queryClient.fetchQuery(catalog),
      queryClient.fetchQuery(meta),
      queryClient.fetchQuery(streams),
      queryClient.fetchQuery(subtitles),
    ]);

    const persisted = [manifest, catalog, meta, streams, subtitles].map((query) =>
      shouldPersistQuery(queryClient.getQueryCache().find({ queryKey: query.queryKey })!),
    );
    expect(persisted).toEqual([true, true, true, false, false]);
  });

  it("cancel the request when the query is cancelled", async () => {
    const { transport, addons } = client({ "https://slow.example/stream/movie/tt1.json": "hang" });
    const queryClient = createQueryClient();
    const query = streamsQuery("https://slow.example", "movie", "tt1", addons);

    void queryClient.fetchQuery(query).catch(() => {});
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalled());
    await queryClient.cancelQueries({ queryKey: query.queryKey });
    expect(vi.mocked(transport.fetch).mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
});
