import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { metaQuery, type LoadedAddon } from "@/lib/addon-protocol";
import { parseManifest, parseMetaResponse } from "@/lib/addon-protocol/parse";
import { useEpisodeMap } from "@/lib/episode-map";
import { createQueryClient } from "@/lib/query";

const kitsu: LoadedAddon = {
  url: "https://kitsu.example/manifest.json",
  manifest: parseManifest({
    id: "kitsu.example",
    version: "1.0.0",
    name: "Kitsu",
    resources: ["meta"],
    types: ["series"],
    idPrefixes: ["kitsu"],
    catalogs: [],
  }),
};

const answer = parseMetaResponse({
  meta: {
    id: "kitsu:12",
    type: "series",
    name: "One Piece",
    videos: [
      {
        id: "kitsu:12:1100",
        title: "Powers on a Different Level!",
        season: 1,
        episode: 1100,
        imdbSeason: 22,
        imdbEpisode: 15,
        absoluteEpisode: 1100,
      },
    ],
  },
});

function setup() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("useEpisodeMap", () => {
  it("finds the map in an addon's details, pending until then", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(metaQuery(kitsu.url, "series", "kitsu:12").queryKey, answer);
    const { result } = renderHook(
      () => useEpisodeMap([kitsu], false, "series", "kitsu:12", "kitsu:12:1100"),
      { wrapper },
    );
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.map).toEqual({ season: 22, episode: 15, absolute: 1100 });
  });

  it("is pending while the addons load, then settles with no map", async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ loading }) => useEpisodeMap([], loading, "series", "kitsu:12", "kitsu:12:1100"),
      { wrapper, initialProps: { loading: true } },
    );
    expect(result.current).toEqual({ map: undefined, pending: true });
    rerender({ loading: false });
    // No addon serves the details: the answer is none, and nothing waits for it.
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.map).toBeUndefined();
  });

  it("settles with no map when the video has none", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(metaQuery(kitsu.url, "series", "kitsu:12").queryKey, answer);
    const { result } = renderHook(
      () => useEpisodeMap([kitsu], false, "series", "kitsu:12", "kitsu:12:1101"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.map).toBeUndefined();
  });

  it("never waits for a video that isn't Kitsu's", () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useEpisodeMap([kitsu], true, "series", "tt0903747", "tt0903747:1:1"),
      { wrapper },
    );
    expect(result.current).toEqual({ map: undefined, pending: false });
  });
});
