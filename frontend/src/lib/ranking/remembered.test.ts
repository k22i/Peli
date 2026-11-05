import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import { StreamEngine, rankStreams } from "./engine";
import { rememberedMatch, type Remembered } from "./remembered";
import { defaultPrefs } from "./score";

// The next episode's streams, ranked with the source the show last played
// from (#58).

const episode: TitleContext = {
  type: "series",
  anime: false,
  id: "tt9:1:2",
  name: "Some Show",
  year: 2023,
  runtimeMin: 50,
  season: 1,
  episode: 2,
};

// A Torrentio-style debrid stream: cached ("+") or not (" download").
let next = 0;
const debrid = (file: string, size = "2.1 GB", marker = "+"): Stream => {
  const n = String(next++).padStart(2, "0");
  return {
    name: `[TB${marker}] Torrentio\n${/2160p/.test(file) ? "4k" : "1080p"}`,
    title: `${file}\n👤 20 💾 ${size} ⚙️ Tracker`,
    url: `https://torrentio.example/resolve/torbox/KEY/${n}${"0".repeat(38)}/null/0/${file}`,
  };
};

const torrentio = "https://torrentio.example/manifest.json";
const comet = "https://comet.example/manifest.json";

const best4k = debrid("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv", "6.4 GB");
const ntb = debrid("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
const other1080 = debrid("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-EDITH.mkv");
const ntb720 = debrid("Some.Show.S01E02.720p.WEB-DL.DDP5.1.H264-NTb.mkv", "1.1 GB");

const top = (remembered: Remembered | null, answers: { source: string; streams: Stream[] }[]) =>
  rankStreams(episode, answers, { ...defaultPrefs, remembered }).top?.parsed.fileName;

describe("the remembered source", () => {
  const answers = [{ source: torrentio, streams: [best4k, other1080, ntb, ntb720] }];

  it("leaves the ranked best on top when nothing is remembered", () => {
    expect(top(null, answers)).toBe("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv");
  });

  it("puts the same quality and group from the same addon on top", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "NTb" } as const;
    expect(top(remembered, answers)).toBe("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
  });

  it("matches the group whatever its case", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "ntb" } as const;
    expect(top(remembered, answers)).toBe("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
  });

  it("takes the group from another addon over the addon with another group", () => {
    const remembered = { source: comet, resolution: "1080p", group: "NTb" } as const;
    const mixed = [
      { source: comet, streams: [debrid("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-EDITH.mkv")] },
      { source: torrentio, streams: [best4k, ntb] },
    ];
    expect(top(remembered, mixed)).toBe("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
  });

  it("takes the same addon and quality, the higher ranked, when the group isn't there", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "SiGMA" } as const;
    const view = rankStreams(episode, answers, { ...defaultPrefs, remembered });
    expect(view.top?.parsed.resolution).toBe("1080p");
    const ranked1080 = view.groups.find((g) => g.tier === "1080p")!.items[0]!;
    expect(view.top).toBe(ranked1080);
  });

  it("never matches another quality alone", () => {
    const remembered = { source: comet, resolution: "1080p", group: "NTb" } as const;
    const only720 = [{ source: torrentio, streams: [best4k, ntb720] }];
    expect(top(remembered, only720)).toBe("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv");
  });

  // #98: a remembered 4K isn't picked over the device's resolution cap.
  it("never picks a match above the resolution cap, and the ranked best stays", () => {
    const remembered = { source: torrentio, resolution: "2160p", group: "FLUX" } as const;
    const capped = { ...defaultPrefs, maxResolution: "1080p" } as const;
    const view = rankStreams(episode, answers, { ...capped, remembered });
    // The ranked best under the cap, not the remembered 4K.
    expect(view.top?.parsed.resolution).toBe("1080p");
    expect(view.top).toBe(rankStreams(episode, answers, capped).top);
    // Without a cap the remembered 4K is the pick, as before.
    expect(top(remembered, answers)).toBe("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv");
  });

  it("still picks a remembered match that fits the cap", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "NTb" } as const;
    const view = rankStreams(episode, answers, {
      ...defaultPrefs,
      maxResolution: "1080p",
      remembered,
    });
    expect(view.top?.parsed.fileName).toBe("Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
  });

  it("never picks a likely fake", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "NTb" } as const;
    // Another season's file, from the remembered group.
    const fake = debrid("Some.Show.S03E05.1080p.WEB-DL.DDP5.1.H264-NTb.mkv");
    const answer = [{ source: torrentio, streams: [best4k, fake] }];
    expect(top(remembered, answer)).toBe("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv");
  });

  it("skips a match that needs a debrid download when the best plays at once", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "NTb" } as const;
    const uncached = debrid(
      "Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H264-NTb.mkv",
      "2.1 GB",
      " download",
    );
    const answer = [{ source: torrentio, streams: [best4k, uncached] }];
    expect(top(remembered, answer)).toBe("Some.Show.S01E02.2160p.WEB-DL.DDP5.1.H265-FLUX.mkv");
  });

  it("counts the addon of any copy of the file", () => {
    const engine = new StreamEngine(episode);
    engine.add(torrentio, [ntb]);
    const [candidate] = engine.view().groups[0]!.items;
    const fromComet = { source: comet, resolution: "1080p", group: null } as const;
    expect(rememberedMatch(fromComet, candidate!)).toBe(0);
    expect(
      rememberedMatch(fromComet, {
        ...candidate!,
        alternates: [{ source: comet, seq: 9, stream: ntb }],
      }),
    ).toBe(1);
  });

  it("keeps a pinned top pick when a closer match arrives later", () => {
    const remembered = { source: torrentio, resolution: "1080p", group: "NTb" } as const;
    const engine = new StreamEngine(episode, { ...defaultPrefs, remembered });
    engine.add(torrentio, [best4k, other1080]);
    engine.pinTop();
    const pinned = engine.view().top;
    engine.add(torrentio, [ntb]);
    expect(engine.view().top).toBe(pinned);
  });
});
