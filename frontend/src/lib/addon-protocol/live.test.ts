import { describe, expect, it } from "vite-plus/test";

import { createAddonClient, type Transport } from "./client";
import { addonsFor, catalogsAccepting, type LoadedAddon } from "./routing";

// The client against real public addons, the way #42–#63 will use it:
// route by manifest, then ask for a catalog, a meta, streams and subtitles.
// Off by default (CI and normal runs use the fixtures); run it with
//
//   SINAG_LIVE_ADDONS=1 pnpm exec vp test run src/lib/addon-protocol/live.test.ts
//
// Node has no CORS, so this is the webview's path only; Go's is tested in
// internal/addons.
const live = import.meta.env["SINAG_LIVE_ADDONS"] === "1";

const transport: Transport = {
  fetch: (url, init) => fetch(url, init),
  fetchViaGo: () => Promise.reject(new Error("no Go in tests")),
};

const urls = [
  "https://v3-cinemeta.strem.io/manifest.json",
  "https://anime-kitsu.strem.fun/manifest.json",
  "https://opensubtitles-v3.strem.io/manifest.json",
  "https://torrentio.strem.fun/manifest.json",
  "https://peerflix.mov/manifest.json",
  "https://comet.elfhosted.com/manifest.json",
];

describe.runIf(live)("live public addons", () => {
  const client = createAddonClient(transport);

  it("routes and answers every resource", { timeout: 120_000 }, async () => {
    const addons: LoadedAddon[] = await Promise.all(
      urls.map(async (url) => ({ url, manifest: await client.manifest(url) })),
    );

    const home = catalogsAccepting(addons, []);
    expect(home.length).toBeGreaterThan(4);
    const [movies] = home;
    const page = await client.catalog(movies!.addon.url, movies!.catalog.type, movies!.catalog.id);
    expect(page.metas.length).toBeGreaterThan(0);
    const first = page.metas[0]!;

    const [metaAddon] = addonsFor(addons, "meta", first.type, first.id);
    const { meta } = await client.meta(metaAddon!.url, first.type, first.id);
    expect(meta.id).toBe(first.id);

    const search = catalogsAccepting(addons, ["search"], "movie")[0]!;
    const found = await client.catalog(search.addon.url, "movie", search.catalog.id, {
      search: "the",
    });
    expect(found.metas.length).toBeGreaterThan(0);

    // Streams from every addon that serves the title, as #50 will ask.
    const streamAddons = addonsFor(addons, "stream", first.type, first.id);
    expect(streamAddons.length).toBeGreaterThan(1);
    const answers = await Promise.allSettled(
      streamAddons.map((addon) => client.streams(addon.url, first.type, first.id)),
    );
    expect(answers.some((a) => a.status === "fulfilled" && a.value.streams.length > 0)).toBe(true);

    const [subtitleAddon] = addonsFor(addons, "subtitles", "movie", "tt0111161");
    const { subtitles } = await client.subtitles(subtitleAddon!.url, "movie", "tt0111161");
    expect(subtitles.length).toBeGreaterThan(0);
  });
});
