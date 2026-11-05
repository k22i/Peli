import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Plugin } from "@bindings/plugins";

import {
  PluginError,
  installedPluginsQuery,
  pluginEditProblem,
  isPluginSource,
  pluginQuery,
  pluginSource,
  pluginStreamsQuery,
  serves,
  sizeBytes,
  toStream,
} from "./plugins";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn<(profile: number, force: boolean) => Promise<number>>(),
  installed: vi.fn<() => Promise<Plugin[] | null>>(),
  streams: vi.fn<() => Promise<unknown>>(),
  cancel: vi.fn<() => void>(),
}));

vi.mock("@bindings/plugins", () => ({
  Service: {
    Installed: () => mocks.installed(),
    Refresh: (profile: number, force: boolean) => mocks.refresh(profile, force),
    Streams: () => Object.assign(mocks.streams(), { cancel: mocks.cancel }),
  },
}));
vi.mock("@bindings/secrets", () => ({ Service: {} }));

const plugin: Plugin = {
  id: "site",
  name: "Site Plugin",
  version: "1.0.0",
  url: "https://plugins.example/site.js",
  supportedTypes: ["movie"],
};

describe("pluginQuery", () => {
  it("asks a film by its TMDB id", () => {
    expect(pluginQuery("movie", "tt0111161", { tmdb: 278, media: "movie" })).toEqual({
      tmdbId: "278",
      mediaType: "movie",
      season: 0,
      episode: 0,
    });
  });

  it("asks an episode with its season and number from the video id", () => {
    expect(pluginQuery("series", "tt0903747:2:5", { tmdb: 1396, media: "tv" })).toEqual({
      tmdbId: "1396",
      mediaType: "tv",
      season: 2,
      episode: 5,
    });
  });

  it("asks nothing without a TMDB id, or an episode's numbers", () => {
    expect(pluginQuery("movie", "tt0111161", null)).toBeUndefined();
    expect(pluginQuery("movie", "tt0111161", undefined)).toBeUndefined();
    expect(pluginQuery("series", "tt0903747", { tmdb: 1396, media: "tv" })).toBeUndefined();
  });
});

describe("serves", () => {
  it("reads the manifest's types, with series and anime for tv", () => {
    expect(serves(plugin, "movie")).toBe(true);
    expect(serves(plugin, "tv")).toBe(false);
    expect(serves({ ...plugin, supportedTypes: ["anime"] }, "tv")).toBe(true);
    expect(serves({ ...plugin, supportedTypes: ["Series"] }, "tv")).toBe(true);
    expect(serves({ ...plugin, supportedTypes: null }, "tv")).toBe(true);
  });
});

describe("sizeBytes", () => {
  it("reads a size as plugins write it", () => {
    expect(sizeBytes("2.5 GB")).toBe(Math.round(2.5 * 2 ** 30));
    expect(sizeBytes("700MB")).toBe(700 * 2 ** 20);
    expect(sizeBytes("1,5 gb")).toBe(Math.round(1.5 * 2 ** 30));
    expect(sizeBytes("unknown")).toBeUndefined();
  });
});

describe("toStream", () => {
  it("makes a plugin's stream look like an addon's", () => {
    expect(
      toStream(plugin, {
        name: "Site",
        title: "Film.2024.1080p.WEB-DL.mkv",
        url: "https://cdn.example/a.m3u8",
        quality: "1080p",
        size: "2 GB",
        headers: { Referer: "https://site.example/" },
      }),
    ).toEqual({
      name: "Site\n1080p",
      description: "Film.2024.1080p.WEB-DL.mkv\n💾 2 GB",
      url: "https://cdn.example/a.m3u8",
      behaviorHints: {
        notWebReady: true,
        bingeGroup: "sinag-plugin-site",
        videoSize: 2 * 2 ** 30,
        proxyHeaders: { request: { Referer: "https://site.example/" } },
      },
    });
  });

  it("names it after the plugin when the stream doesn't say", () => {
    const stream = toStream(plugin, { name: "", title: "", url: "https://cdn.example/b.mp4" });
    expect(stream).toEqual({
      name: "Site Plugin",
      url: "https://cdn.example/b.mp4",
      behaviorHints: { notWebReady: true, bingeGroup: "sinag-plugin-site" },
    });
  });
});

describe("pluginSource", () => {
  it("tells a plugin's source from an addon's URL", () => {
    expect(pluginSource(plugin)).toBe("plugin:site");
    expect(isPluginSource("plugin:site")).toBe(true);
    expect(isPluginSource("https://torrentio.strem.fun/manifest.json")).toBe(false);
  });
});

describe("pluginStreamsQuery", () => {
  const query = { tmdbId: "278", mediaType: "movie", season: 0, episode: 0 };

  it("gives the streams as addon streams", async () => {
    mocks.streams.mockResolvedValueOnce([
      { name: "Site", title: "", url: "https://cdn.example/a" },
    ]);
    const streams = await new QueryClient().fetchQuery(pluginStreamsQuery(plugin, query));
    expect(streams).toEqual([
      toStream(plugin, { name: "Site", title: "", url: "https://cdn.example/a" }),
    ]);
  });

  it("says why a call failed by its code, and nothing the plugin wrote", async () => {
    mocks.streams.mockRejectedValueOnce(new Error("raw", { cause: { code: "memory" } }));
    const failed = new QueryClient().fetchQuery(pluginStreamsQuery(plugin, query));
    await expect(failed).rejects.toEqual(new PluginError("memory"));
    await expect(failed).rejects.toThrow("The plugin used too much memory.");

    mocks.streams.mockRejectedValueOnce(new Error("raw", { cause: { code: "toString" } }));
    await expect(new QueryClient().fetchQuery(pluginStreamsQuery(plugin, query))).rejects.toThrow(
      "The plugin failed.",
    );
  });

  it("cancels the call, killing its sandbox, when the query is", async () => {
    mocks.streams.mockReturnValueOnce(new Promise(() => {}));
    const client = new QueryClient();
    void client.fetchQuery(pluginStreamsQuery(plugin, query)).catch(() => {});
    await vi.waitFor(() => expect(mocks.streams).toHaveBeenCalled());
    await client.cancelQueries({ queryKey: ["plugin-streams"] });
    expect(mocks.cancel).toHaveBeenCalled();
  });
});

describe("installed plugins", () => {
  it("reads Go's list for the profile, after letting it read new repositories", async () => {
    mocks.refresh.mockResolvedValue(1);
    mocks.installed.mockResolvedValue([plugin]);

    const list = await new QueryClient().fetchQuery(installedPluginsQuery(3));

    expect(list).toEqual([plugin]);
    expect(mocks.refresh).toHaveBeenCalledWith(3, false);
  });

  it("still lists them when a repository didn't answer, and has none for a null list", async () => {
    mocks.refresh.mockRejectedValue(new Error("offline"));
    mocks.installed.mockResolvedValue([plugin]);
    expect(await new QueryClient().fetchQuery(installedPluginsQuery(3))).toEqual([plugin]);

    mocks.installed.mockResolvedValue(null);
    expect(await new QueryClient().fetchQuery(installedPluginsQuery(3))).toEqual([]);
  });

  it("waits for the profile, and keeps each profile's list apart", () => {
    expect(installedPluginsQuery(undefined).enabled).toBe(false);
    expect(installedPluginsQuery(1).queryKey).not.toEqual(installedPluginsQuery(2).queryKey);
  });
});

const coded = (code: string) => new Error(code, { cause: { code } });

describe("plugin edit problems", () => {
  it("tells what Go refused", () => {
    expect(pluginEditProblem(coded("not_a_repository")).title).toBe("No plugins found");
    expect(pluginEditProblem(coded("bad_address")).title).toBe("That isn’t a repository address");
    expect(pluginEditProblem(coded("kids_profile")).description).toBe(
      "Kids profiles don’t use plugins.",
    );
    expect(pluginEditProblem(new Error("x")).title).toBe("Couldn’t change plugins");
  });
});
