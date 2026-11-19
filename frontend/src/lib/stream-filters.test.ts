import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";
import { rankStreams, type Candidate, type RankedView, type TitleContext } from "@/lib/ranking";
import {
  facetChips,
  filterView,
  filtersKey,
  filtersLabel,
  isFiltered,
  noFilters,
  offered,
  sortItems,
  sortsAvailable,
  toggle,
  valuesOf,
  withText,
  type StreamFilters,
} from "@/lib/stream-filters";

const movie: TitleContext = {
  type: "movie",
  anime: false,
  id: "tt1",
  name: "Some Film",
  year: 2024,
  runtimeMin: 120,
};

let hashes = 0;
const nextHash = () => (hashes++).toString(16).padStart(40, "a");

const cached = (file: string, gb = 4): Stream => {
  const hash = nextHash();
  return {
    name: "[TB⚡] Comet",
    description: `📄 ${file}\n💾 ${gb} GB`,
    url: `https://comet.example/playback/${hash}`,
    behaviorHints: { bingeGroup: `comet|torbox|${hash}`, filename: file, videoSize: gb * 1e9 },
  };
};
const uncached = (file: string, gb = 4): Stream => ({
  ...cached(file, gb),
  name: "[TB⬇️] Comet",
});
const p2p = (file: string, gb = 4, seeders = 10): Stream => ({
  name: "Torrentio",
  description: `${file}\n👤 ${seeders} 💾 ${gb} GB ⚙️ Tracker`,
  infoHash: nextHash(),
  fileIdx: 0,
  behaviorHints: { filename: file },
});

function view(answers: { source: string; streams: Stream[] }[]): RankedView {
  return rankStreams(movie, answers);
}

const names = (v: RankedView) =>
  v.groups.flatMap(({ items }) => items.map((c) => c.parsed.fileName));

const sample = () =>
  view([
    {
      source: "https://comet",
      streams: [
        cached("Some.Film.2024.2160p.WEB-DL.DV.HDR10.DDP5.1.Atmos.H265-GRP.mkv", 20),
        cached("Some.Film.2024.1080p.BluRay.TrueHD.7.1.x264-GRP.mkv", 12),
        uncached("Some.Film.2024.2160p.REMUX.HDR10.TrueHD.7.1.HEVC-OTHER.mkv", 60),
      ],
    },
    {
      source: "https://torrentio",
      streams: [
        p2p("Some.Film.2024.720p.WEB.x264-SMALL.mkv", 1, 300),
        p2p("Some.Film.2024.1080p.WEB.AAC2.0.x265-ITA.mkv", 2, 5),
        p2p("Some.Film.2024.1080p.CAM.x264-BAD.mkv", 2, 900),
      ],
    },
  ]);

const choose = (...pairs: [Parameters<typeof toggle>[1], string][]): StreamFilters =>
  pairs.reduce((filters, [facet, value]) => toggle(filters, facet, value), noFilters);

describe("valuesOf", () => {
  it("reads each facet from what the stream claims", () => {
    const dv = sample().groups[0]!.items[0]!;
    expect(valuesOf("plays", dv)).toEqual(["cached"]);
    expect(valuesOf("resolution", dv)).toEqual(["4K"]);
    expect(valuesOf("hdr", dv)).toEqual(["DV", "HDR10"]);
    expect(valuesOf("audio", dv)).toEqual(["atmos", "surround"]);
    expect(valuesOf("codec", dv)).toEqual(["hevc"]);
    expect(valuesOf("source", dv)).toEqual(["https://comet"]);
  });
});

describe("filterView", () => {
  it("is the view itself with no filters and the best match", () => {
    const v = sample();
    expect(filterView(v, noFilters, "best")).toBe(v);
  });

  it("widens within a facet and narrows across facets", () => {
    const v = sample();
    const fourK = filterView(v, choose(["resolution", "4K"]), "best");
    expect(fourK.groups.map((g) => g.tier)).toEqual(["4K"]);
    expect(fourK.total).toBe(2);
    const either = filterView(v, choose(["resolution", "4K"], ["resolution", "720p"]), "best");
    expect(either.groups.map((g) => g.tier)).toEqual(["4K", "720p"]);
    const cachedFourK = filterView(v, choose(["resolution", "4K"], ["plays", "cached"]), "best");
    expect(cachedFourK.total).toBe(1);
  });

  it("moves the top pick to the best that passes", () => {
    const v = sample();
    expect(v.top?.parsed.resolution).toBe("2160p");
    const p2pOnly = filterView(v, choose(["plays", "p2p"]), "best");
    expect(p2pOnly.top?.parsed.fileName).toMatch(/1080p\.WEB/);
    // Never a CAM.
    expect(p2pOnly.top?.tier).not.toBe("Low quality");
  });

  it("keeps a top pick the user pinned for these filters", () => {
    const v = sample();
    const filters = choose(["plays", "p2p"]);
    const small = v.groups.find((g) => g.tier === "720p")!.items[0]!;
    expect(filterView(v, filters, "best", { pinned: small.key }).top).toBe(small);
  });

  it("has no top pick when nothing outside the collapsed groups passes", () => {
    const v = sample();
    const filtered = filterView(v, withText(noFilters, "BAD"), "best");
    expect(filtered.top).toBeNull();
    expect(filtered.groups.map((g) => g.tier)).toEqual(["Low quality"]);
  });

  it("searches every word in the release and file names", () => {
    const v = sample();
    expect(names(filterView(v, withText(noFilters, "remux hevc"), "best"))).toEqual([
      "Some.Film.2024.2160p.REMUX.HDR10.TrueHD.7.1.HEVC-OTHER.mkv",
    ]);
    expect(filterView(v, withText(noFilters, "   "), "best")).toBe(v);
  });

  it("sorts within each group and keeps the groups", () => {
    const v = sample();
    const smallest = filterView(v, noFilters, "size-asc");
    expect(smallest.groups.map((g) => g.tier)).toEqual(v.groups.map((g) => g.tier));
    const fourK = smallest.groups[0]!.items.map((c) => c.parsed.sizeBytes);
    expect(fourK).toEqual([20e9, 60e9]);
    const largest = filterView(v, noFilters, "size-desc").groups[0]!.items;
    expect(largest.map((c) => c.parsed.sizeBytes)).toEqual([60e9, 20e9]);
    expect(filterView(v, noFilters, "size-asc").top).toBe(v.top);
  });
});

const sizes = (sorted: Candidate[]) => sorted.map((c) => c.parsed.sizeBytes);

describe("sortItems", () => {
  it("puts season packs and unknown sizes last, and sorts seeders", () => {
    const base = sample().groups[0]!.items[0]!;
    const rows: [number | null, boolean, number | null][] = [
      [5, true, 1],
      [null, false, null],
      [2, false, 50],
      [9, false, 3],
    ];
    const items: Candidate[] = rows.map(([sizeBytes, pack, seeders]) =>
      Object.assign({}, base, { parsed: { ...base.parsed, sizeBytes, pack, seeders } }),
    );
    expect(sizes(sortItems(items, "size-desc"))).toEqual([9, 2, null, 5]);
    expect(sizes(sortItems(items, "size-asc"))).toEqual([2, 9, null, 5]);
    expect(sortItems(items, "seeders").map((c) => c.parsed.seeders)).toEqual([50, 3, 1, null]);
    expect(sortItems(items, "best")).toEqual(items);
  });

  it("offers Most seeders only with P2P streams", () => {
    const v = sample();
    expect(sortsAvailable(offered(v))).toContain("seeders");
    const debridOnly = offered(v).filter((c) => c.parsed.cached !== null);
    expect(sortsAvailable(debridOnly)).not.toContain("seeders");
  });
});

describe("facetChips", () => {
  const context = {
    languages: ["it"],
    names: new Map([
      ["https://comet", "Comet"],
      ["https://torrentio", "Torrentio"],
    ]),
  };

  it("shows a facet only where the streams differ, and never counts CAMs", () => {
    const v = sample();
    const chips = facetChips(offered(v), noFilters, context);
    const plays = chips.find((c) => c.facet === "plays")!;
    expect(plays.options.map((o) => [o.label, o.count])).toEqual([
      ["Cached", 2],
      ["P2P", 2],
      ["Not cached", 1],
    ]);
    // All five have a codec the parser knows, but they differ on it.
    expect(chips.find((c) => c.facet === "codec")).toBeDefined();
    const one = view([{ source: "https://comet", streams: [cached("A.2024.1080p.WEB.x264.mkv")] }]);
    expect(facetChips(offered(one), noFilters, context)).toEqual([]);
  });

  it("counts each chip with the other facets' filters applied", () => {
    const v = sample();
    const chips = facetChips(offered(v), choose(["resolution", "4K"]), context);
    const plays = chips.find((c) => c.facet === "plays")!;
    expect(plays.options.map((o) => [o.value, o.count])).toEqual([
      ["cached", 1],
      ["p2p", 0],
      ["uncached", 1],
    ]);
    const resolution = chips.find((c) => c.facet === "resolution")!;
    expect(resolution.options.find((o) => o.value === "1080p")).toMatchObject({
      count: 2,
      chosen: false,
    });
  });

  it("lists the profile's languages first", () => {
    const v = view([
      {
        source: "https://torrentio",
        streams: [
          p2p("Some.Film.2024.1080p.WEB.FRENCH.x264.mkv"),
          p2p("Some.Film.2024.1080p.WEB.ITA.x264.mkv"),
          p2p("Some.Film.2024.1080p.WEB.x264.mkv"),
        ],
      },
    ]);
    const languages = facetChips(offered(v), noFilters, {
      ...context,
      languageName: (code) => ({ fr: "French", it: "Italian" })[code] ?? code,
    }).find((c) => c.facet === "language");
    expect(languages?.options.map((o) => o.label)).toEqual(["Italian", "French"]);
  });
});

describe("filtersLabel", () => {
  it("says what the filters keep", () => {
    expect(filtersLabel(noFilters)).toBeNull();
    expect(filtersLabel(choose(["resolution", "4K"]))).toBe("4K only");
    expect(filtersLabel(choose(["resolution", "720p"], ["resolution", "4K"]))).toBe(
      "4K or 720p only",
    );
    expect(filtersLabel(choose(["resolution", "4K"], ["plays", "cached"]))).toBe(
      "Cached · 4K only",
    );
    expect(filtersLabel(withText(choose(["hdr", "DV"], ["codec", "av1"]), "remux"))).toBe(
      "3 filters",
    );
  });

  it("keys filters by what they keep", () => {
    expect(isFiltered(toggle(choose(["hdr", "DV"]), "hdr", "DV"))).toBe(false);
    expect(filtersKey(choose(["hdr", "DV"], ["hdr", "SDR"]))).toBe(
      filtersKey(choose(["hdr", "SDR"], ["hdr", "DV"])),
    );
  });
});
