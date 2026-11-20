import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";
import { candidate, parseStream, type TitleContext } from "@/lib/ranking";

import {
  audioLabel,
  bitrateLabel,
  delivery,
  languagesLabel,
  rawNames,
  reasonsLabel,
  resolutionLabel,
  sizeLabel,
  sizeText,
  sourceLabel,
  videoCodecLabel,
} from "./stream-labels";

const film: TitleContext = {
  type: "movie",
  anime: false,
  id: "tt0111161",
  name: "The Shawshank Redemption",
  year: 1994,
  runtimeMin: 142,
};

const hash = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";

const comet = (name: string, description: string): Stream => ({
  name,
  description,
  url: "https://comet.example/KEY/playback",
});

describe("stream labels", () => {
  it("names what a cached debrid stream claims", () => {
    const parsed = parseStream(
      comet(
        "[TB⚡] Comet 2160p",
        "📄 The.Shawshank.Redemption.1994.2160p.UHD.BluRay.REMUX.DV.HDR10.TrueHD.Atmos.7.1-FGT.mkv\n💾 58.3 GB 🔎 TorBox\n🇬🇧",
      ),
    );
    expect(resolutionLabel(parsed)).toBe("4K");
    expect(parsed.hdr).toEqual(expect.arrayContaining(["DV", "HDR10"]));
    expect(audioLabel(parsed)).toBe("TrueHD 7.1");
    expect(parsed.atmos).toBe(true);
    expect(sourceLabel(parsed)).toBe("Remux");
    expect(sizeLabel(parsed.sizeBytes)).toMatch(/^6\d(\.\d)? GB$/);
    expect(delivery(parsed)).toEqual({ kind: "cached", label: "Cached · TorBox" });
    expect(languagesLabel(parsed)).toBe("EN");
  });

  it("tells a stream that isn't cached from a peer-to-peer one", () => {
    const uncached = parseStream({
      name: "[TB download] Torrentio\n1080p",
      title: "Film.1994.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv\n👤 20 💾 2.1 GB ⚙️ Tracker",
      url: "https://torrentio.strem.fun/resolve/torbox/KEY/x",
    });
    expect(delivery(uncached)).toEqual({ kind: "uncached", label: "Not cached · TorBox" });
    expect(audioLabel(uncached)).toBe("DD+ 5.1");
    expect(sourceLabel(uncached)).toBe("WEB-DL");

    const p2p = parseStream({
      name: "Torrentio\n1080p",
      title: "Film.1994.1080p.BluRay.x264-GRP.mkv\n👤 1 💾 2.1 GB ⚙️ Tracker",
      infoHash: hash,
      fileIdx: 0,
    });
    expect(delivery(p2p)).toEqual({ kind: "p2p", label: "P2P · 1 seeder" });
  });

  it("says nothing the stream doesn't", () => {
    const parsed = parseStream({ name: "Source", url: "https://example.com/KEY" });
    expect(resolutionLabel(parsed)).toBeNull();
    expect(audioLabel(parsed)).toBeNull();
    expect(sourceLabel(parsed)).toBeNull();
    expect(sizeLabel(parsed.sizeBytes)).toBeNull();
    expect(delivery(parsed)).toBeNull();
    expect(languagesLabel(parsed)).toBeNull();
    expect(rawNames(parsed)).toEqual([]);
  });

  it("formats sizes in decimal units", () => {
    expect(sizeLabel(2_100_000_000)).toBe("2.1 GB");
    expect(sizeLabel(734_003_200)).toBe("734 MB");
    expect(sizeLabel(1_500_000_000_000)).toBe("1.5 TB");
    expect(sizeLabel(0)).toBeNull();
  });

  it("lists up to three languages", () => {
    const parsed = { ...parseStream({ name: "x" }), languages: ["en", "fr", "de", "it", "multi"] };
    expect(languagesLabel(parsed)).toBe("EN · FR · DE · +2");
  });

  it("says why a stream is a likely fake, but not a title mismatch", () => {
    const wrongYear = candidate(
      "https://torrentio.strem.fun/manifest.json",
      {
        name: "Torrentio\n1080p",
        title: "Dune.Part.Two.2024.1080p.WEB-DL.x264-GRP.mkv\n👤 20 💾 2.1 GB",
        infoHash: hash,
      },
      0,
      film,
    );
    expect(wrongYear.tier).toBe("Likely fake");
    expect(reasonsLabel(wrongYear)).toBe("Another year’s release");
  });

  it("gives the raw names, the file as the addon sent it first", () => {
    const parsed = parseStream({
      name: "Torrentio\n2160p",
      title: "Pack.S01.2160p.DoVi.HDR10x265-GRP\nPack.S01E02.DoVi.HDR10x265-GRP.mkv\n👤 9",
      infoHash: hash,
    });
    expect(rawNames(parsed)).toEqual([
      "Pack.S01E02.DoVi.HDR10x265-GRP.mkv",
      "Pack.S01.2160p.DoVi.HDR10 x265-GRP",
    ]);
  });
});

const stream = (file: string, size: string) =>
  parseStream({
    name: "[TB+] Torrentio\n1080p",
    title: `${file}\n👤 20 💾 ${size} ⚙️ Tracker`,
    url: "https://torrentio.strem.fun/resolve/torbox/KEY/x",
  });

describe("size, bitrate and codec labels", () => {
  // Addons write sizes in 1024s ("2.1 GB" is 2.1 × 2³⁰ bytes, parse.ts), shown
  // in decimal units, so the labels are tested from bytes.
  const single = {
    ...stream("Film.1994.1080p.BluRay.x265-GRP.mkv", "2.1 GB"),
    sizeBytes: 2.1e9,
  };

  it("badges HEVC, AV1 and H.264, and nothing for older codecs", () => {
    expect(videoCodecLabel(single)).toBe("HEVC");
    expect(videoCodecLabel(stream("Film.2020.1080p.WEB-DL.AV1-GRP.mkv", "1 GB"))).toBe("AV1");
    expect(videoCodecLabel(stream("Film.2020.1080p.WEB-DL.H.264-GRP.mkv", "1 GB"))).toBe("H.264");
    expect(videoCodecLabel({ ...single, videoCodec: "xvid" })).toBeNull();
    expect(videoCodecLabel({ ...single, videoCodec: null })).toBeNull();
  });

  it("calls a pack's size a pack's", () => {
    expect(sizeText(single)).toBe("2.1 GB");
    expect(sizeText({ ...single, pack: true, sizeBytes: 48e9 })).toBe("Pack · 48 GB");
    expect(sizeText({ ...single, sizeBytes: null })).toBeNull();
  });

  it("estimates the bitrate from the size and the runtime, never for a pack", () => {
    expect(bitrateLabel(single, 142)).toBe("~2 Mbps");
    expect(bitrateLabel({ ...single, sizeBytes: 58.3e9 }, 142)).toBe("~55 Mbps");
    expect(bitrateLabel({ ...single, pack: true }, 142)).toBeNull();
    expect(bitrateLabel(single, null)).toBeNull();
    expect(bitrateLabel({ ...single, sizeBytes: null }, 142)).toBeNull();
  });
});
