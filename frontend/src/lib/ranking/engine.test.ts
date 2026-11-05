import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import { labelled } from "./accuracy";
import type { TitleContext } from "./context";
import corpus from "./corpus/labelled.json";
import { StreamEngine, rankStreams } from "./engine";
import { judge } from "./fakes";
import { parseStream } from "./parse";
import { defaultPrefs, scoreStream } from "./score";

const hash = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";
const movie: TitleContext = {
  type: "movie",
  anime: false,
  id: "tt1",
  name: "Some Film",
  year: 2024,
  runtimeMin: 120,
};
const episode: TitleContext = {
  type: "series",
  anime: true,
  id: "kitsu:1:1",
  name: "Some Show",
  year: 2023,
  runtimeMin: 24,
  episode: 1,
};

const p2p = (file: string, size = "4.2 GB", seeders = 50, infoHash = hash): Stream => ({
  name: "Torrentio\n1080p",
  description: `${file}\n👤 ${seeders} 💾 ${size} ⚙️ Tracker`,
  infoHash,
  fileIdx: 0,
  behaviorHints: { filename: file },
});
const cached = (file: string, size = 4.2 * 2 ** 30, infoHash = hash): Stream => ({
  name: "[TB⚡] Comet 1080p",
  description: `📄 ${file}\n💾 ${(size / 2 ** 30).toFixed(1)} GB`,
  url: "https://comet.example/playback/<opaque>",
  behaviorHints: { bingeGroup: `comet|torbox|${infoHash}`, filename: file, videoSize: size },
});

const verdict = (file: string, ctx: TitleContext) =>
  judge(parseStream(p2p(file), { type: ctx.type, anime: ctx.anime }), ctx).bucket;

describe("judge", () => {
  it("hides another season, extras and executables, and keeps CAMs apart", () => {
    expect(verdict("Some.Show.S02E01.1080p.WEB-DL-GRP.mkv", episode)).toBe("hidden");
    expect(verdict("Some Film 2024 Trailer 2 [4K].mp4", movie)).toBe("hidden");
    expect(verdict("Some Film 2024 1080p WEB H264-GRP.exe", movie)).toBe("hidden");
    expect(verdict("Some.Film.2010.1080p.WEB-DL.H264-GRP.mkv", movie)).toBe("hidden");
    expect(verdict("Some.Film.2024.1080p.CAM.H264-GRP.mkv", movie)).toBe("low quality");
    expect(verdict("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv", movie)).toBe("ok");
  });

  it("hides a file too small to be the whole film", () => {
    const p = parseStream(p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv", "40 MB"), {
      type: "movie",
    });
    expect(judge(p, movie)).toEqual({ bucket: "hidden", reasons: ["too small"] });
  });

  it("only reports a title that shares no word with the asked-for one", () => {
    const p = parseStream(p2p("Other.Thing.2024.1080p.WEB-DL.H264-GRP.mkv"), { type: "movie" });
    expect(judge(p, movie)).toEqual({ bucket: "ok", reasons: ["title mismatch"] });
  });
});

const score = (stream: Stream, prefs = defaultPrefs) => {
  const p = parseStream(stream, { type: "movie" });
  return scoreStream(p, judge(p, movie), movie, prefs);
};

// The ranked order, by arrival number.
const order = (engine: StreamEngine) =>
  engine.view().groups.flatMap((group) => group.items.map((c) => c.seq));

describe("scoreStream", () => {
  it("puts a cached 720p above an uncached 4K remux", () => {
    const remux = p2p("Some.Film.2024.2160p.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-GRP.mkv", "60 GB");
    expect(score(cached("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", 2 ** 30))).toBeGreaterThan(
      score(remux),
    );
  });

  it("puts a preferred language first, and never penalizes one that says none", () => {
    const english = { ...defaultPrefs, languages: ["en"] };
    const french = score(p2p("Some.Film.2024.2160p.WEB-DL.FRENCH.H265-GRP.mkv", "15 GB"), english);
    const stated = score(p2p("Some.Film.2024.1080p.WEB-DL.ENG.H264-GRP.mkv"), english);
    const silent = score(p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv"));
    expect(stated).toBeGreaterThan(french);
    expect(score(p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv"), english)).toBe(silent);
  });

  it("drops what's over the resolution cap below what fits", () => {
    const capped = { ...defaultPrefs, maxResolution: "1080p" as const };
    expect(score(p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv"), capped)).toBeGreaterThan(
      score(p2p("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", "15 GB"), capped),
    );
  });

  // #98: "with a 1080p cap, 4K streams rank below every stream that fits",
  // whatever else the fitting one lacks.
  it("ranks a cached 4K below every stream that fits the cap", () => {
    const capped = { ...defaultPrefs, maxResolution: "1080p" as const };
    const cached4k = score(
      cached("Some.Film.2024.2160p.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-GRP.mkv", 60 * 2 ** 30),
      { ...capped, languages: ["en"] },
    );
    const fitting = [
      // Uncached, a dead swarm, and in a language it isn't asked for.
      p2p("Some.Film.2024.360p.WEB-DL.FRENCH.H264-GRP.mkv", "400 MB", 0),
      p2p("Some.Film.2024.720p.WEB-DL.FRENCH.H264-GRP.mkv", "1 GB", 0),
      p2p("Some.Film.2024.1080p.WEB-DL.FRENCH.H264-GRP.mkv", "2 GB", 0),
      // Dolby Vision with nothing to fall back on.
      p2p("Some.Film.2024.1080p.WEB-DL.DV.H265-GRP.mkv", "4 GB"),
    ];
    for (const stream of fitting) {
      expect(score(stream, { ...capped, languages: ["en"] })).toBeGreaterThan(cached4k);
    }
  });

  it("doesn't cap anything by default, or at 4K", () => {
    const remux = p2p("Some.Film.2024.2160p.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-GRP.mkv", "60 GB");
    const fhd = p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv");
    expect(score(remux)).toBeGreaterThan(score(fhd));
    expect(score(remux, { ...defaultPrefs, maxResolution: "2160p" })).toBe(score(remux));
  });

  describe("Dolby Vision and HDR", () => {
    const dvOnly = p2p("Some.Film.2024.2160p.WEB-DL.DV.H265-GRP.mkv", "15 GB");
    const withFallback = p2p("Some.Film.2024.2160p.WEB-DL.DV.HDR10.H265-GRP.mkv", "15 GB");
    const hdr10 = p2p("Some.Film.2024.2160p.WEB-DL.HDR10.H265-GRP.mkv", "15 GB");
    const sdr = p2p("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", "15 GB");

    it("with Dolby Vision off, ranks DV-only below the same stream with an HDR10 layer", () => {
      for (const hdr of [true, false]) {
        const off = { ...defaultPrefs, hdr, dolbyVision: false };
        expect(score(withFallback, off)).toBeGreaterThan(score(dvOnly, off));
        expect(score(hdr10, off)).toBeGreaterThan(score(dvOnly, off));
        // Wrong colours are worse than no HDR at all.
        expect(score(sdr, off)).toBeGreaterThan(score(dvOnly, off));
      }
    });

    it("with Dolby Vision on, ranks it first and doesn't penalize DV-only", () => {
      const on = { ...defaultPrefs, hdr: true, dolbyVision: true };
      expect(score(dvOnly, on)).toBeGreaterThan(score(hdr10, on));
      expect(score(dvOnly, on)).toBeGreaterThan(score(sdr, on));
    });

    it("with HDR off, HDR10 earns nothing", () => {
      expect(score(hdr10, { ...defaultPrefs, hdr: false })).toBe(score(sdr));
      expect(score(hdr10, { ...defaultPrefs, hdr: true })).toBeGreaterThan(score(sdr));
    });
  });
});

describe("StreamEngine", () => {
  const file = "Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv";

  it("keeps one copy of a file across addons, the one that plays soonest", () => {
    const engine = new StreamEngine(movie);
    expect(engine.add("torrentio", [p2p(file)])).toBe(1);
    expect(engine.add("comet", [cached(file)])).toBe(0);
    const { top, total } = engine.view();
    expect(total).toBe(1);
    expect(top?.source).toBe("comet");
    expect(top?.alternates.map((a) => [a.source, a.seq])).toEqual([["torrentio", 0]]);
  });

  it("takes the same file name and size in another torrent for one file", () => {
    const engine = new StreamEngine(movie);
    engine.add("a", [p2p(file, "4.2 GB", 50, "a".repeat(40))]);
    engine.add("b", [p2p(file, "4.21 GB", 10, "b".repeat(40))]);
    expect(engine.view().total).toBe(1);
  });

  it("groups by quality tier, with fakes and CAMs last", () => {
    const view = rankStreams(movie, [
      {
        source: "a",
        streams: [
          p2p("Some.Film.2024.1080p.CAM.H264-GRP.mkv", "2 GB", 50, "1".repeat(40)),
          p2p("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", "2 GB", 50, "2".repeat(40)),
          p2p("Some.Film.2024.Trailer.2160p.mkv", "200 MB", 50, "3".repeat(40)),
          p2p("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", "15 GB", 50, "4".repeat(40)),
        ],
      },
    ]);
    expect(view.groups.map((g) => g.tier)).toEqual(["4K", "720p", "Low quality", "Likely fake"]);
    expect(view.top?.tier).toBe("4K");
  });

  // #98: over the cap, the group follows the ones that fit.
  it("lists the groups above the resolution cap after the ones that fit", () => {
    const answers = [
      {
        source: "a",
        streams: [
          p2p("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", "15 GB", 50, "1".repeat(40)),
          p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv", "2 GB", 50, "2".repeat(40)),
          p2p("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", "1 GB", 50, "3".repeat(40)),
          p2p("Some.Film.2024.480p.WEB-DL.H264-GRP.mkv", "700 MB", 50, "4".repeat(40)),
          p2p("Some.Film.2024.1080p.CAM.H264-GRP.mkv", "2 GB", 50, "5".repeat(40)),
        ],
      },
    ];
    const tiers = (maxResolution: "2160p" | "1080p" | "720p") =>
      rankStreams(movie, answers, { ...defaultPrefs, maxResolution }).groups.map((g) => g.tier);
    expect(tiers("2160p")).toEqual(["4K", "1080p", "720p", "SD", "Low quality"]);
    expect(tiers("1080p")).toEqual(["1080p", "720p", "SD", "4K", "Low quality"]);
    // The nearest to the cap first.
    expect(tiers("720p")).toEqual(["720p", "SD", "1080p", "4K", "Low quality"]);

    // The pick is the best that fits.
    const view = rankStreams(movie, answers, { ...defaultPrefs, maxResolution: "1080p" });
    expect(view.top?.tier).toBe("1080p");
  });

  it("picks the top pick that fits, and a cached 4K waits below an uncached 1080p", () => {
    const view = rankStreams(
      movie,
      [
        { source: "a", streams: [p2p("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv", "2 GB", 0)] },
        {
          source: "b",
          streams: [
            cached("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", 15 * 2 ** 30, "9".repeat(40)),
          ],
        },
      ],
      { ...defaultPrefs, maxResolution: "1080p" },
    );
    expect(view.top?.source).toBe("a");
    expect(view.groups.map((g) => g.tier)).toEqual(["1080p", "4K"]);
  });

  it("keeps the pinned top pick when a better stream arrives", () => {
    const engine = new StreamEngine(movie);
    engine.add("torrentio", [p2p("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", "2 GB")]);
    const first = engine.view().top;
    engine.pinTop();
    engine.add("comet", [
      cached("Some.Film.2024.2160p.WEB-DL.DV.HDR.H265-GRP.mkv", 20 * 2 ** 30, "a".repeat(40)),
    ]);
    expect(engine.view().top).toBe(first);
    expect(engine.view().groups[0]?.items[0]?.source).toBe("comet");
  });

  it("hands on what changed since it was last asked", () => {
    const engine = new StreamEngine(movie);
    engine.add("torrentio", [p2p(file)]);
    expect(engine.takeChanges().map((c) => c.source)).toEqual(["torrentio"]);
    engine.add("other", [p2p(file)]);
    const [changed] = engine.takeChanges();
    expect(changed?.source).toBe("torrentio");
    expect(changed?.alternates).toHaveLength(1);
    expect(engine.takeChanges()).toEqual([]);
  });

  it("ranks the same incrementally as all at once", () => {
    const rows = labelled(corpus);
    for (const title of new Set(rows.map((row) => row.ctx.id))) {
      const ofTitle = rows.filter((row) => row.ctx.id === title);
      const ctx = ofTitle[0]!.ctx;
      const incremental = new StreamEngine(ctx);
      for (const row of ofTitle) incremental.add(row.addon, [row.stream]);
      const once = new StreamEngine(ctx);
      once.add(
        "all",
        ofTitle.map((row) => row.stream),
      );
      expect(order(incremental)).toEqual(order(once));
    }
  });
});
