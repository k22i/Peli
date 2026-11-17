import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import meteor from "./fixtures/meteor-torbox.json";
import { parseStream } from "./parse";

const hash = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";

const torrentio = (file: string, name = "Torrentio\n1080p"): Stream => ({
  name,
  description: `${file}\n👤 50 💾 4.2 GB ⚙️ Tracker`,
  infoHash: hash,
  fileIdx: 0,
  behaviorHints: { filename: file },
});

describe("parseStream", () => {
  it("reads a typical scene name", () => {
    const p = parseStream(
      torrentio("Some.Film.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP.mkv"),
      { type: "movie" },
    );
    expect(p).toMatchObject({
      resolution: "2160p",
      source: "remux",
      videoCodec: "hevc",
      audioCodec: "truehd",
      channels: "7.1",
      atmos: true,
      group: "GRP",
      year: 2024,
      sizeBytes: Math.round(4.2 * 2 ** 30),
      seeders: 50,
      cached: null,
      infoHash: hash,
      fileIdx: 0,
    });
    expect(p.hdr.toSorted()).toEqual(["DV", "HDR10"]);
  });

  it("takes the hash from a debrid resolve URL or a binge group", () => {
    const url = `https://torrentio.example/resolve/torbox/<key>/${hash}/null/0/file.mkv`;
    expect(parseStream({ name: "[TB+] Torrentio", url }).infoHash).toBe(hash);
    const binge = { bingeGroup: `comet|torbox|${hash.toUpperCase()}` };
    expect(parseStream({ name: "[TB⚡] Comet", behaviorHints: binge }).infoHash).toBe(hash);
  });

  it.each([
    ["[TB+] Torrentio", "TB", true],
    ["[TB download] Torrentio", "TB", false],
    ["[RD+] Torrentio", "RD", true],
    ["[AD download] Torrentio", "AD", false],
    ["[PM+] Torrentio", "PM", true],
    ["[TB⚡] Comet 1080p", "TB", true],
    ["[AD⚡️] Comet 1080p", "AD", true],
    ["[PM⬇️] Comet 1080p", "PM", false],
    ["[RD⏳] Comet 1080p", "RD", false],
  ])("reads %s as %s, cached %s", (name, debrid, cached) => {
    expect(parseStream({ name, description: "x" })).toMatchObject({ debrid, cached });
  });

  it("reads Meteor's markers from a recorded TorBox response", () => {
    const read = meteor.streams.map((s) => parseStream(s as Stream, { type: "movie" }));
    expect(read.map((p) => [p.debrid, p.cached])).toEqual([
      ["TB", true],
      ["TB", true],
      ["TB", true],
      ["TB", false],
      ["TB", false],
      ["TB", false],
    ]);
  });

  it("doesn't take a language tag for a debrid service", () => {
    expect(parseStream({ name: "[EN] Addon 1080p" })).toMatchObject({ debrid: null, cached: null });
  });

  it("reads Spanish episode tags", () => {
    const p = parseStream(
      { name: "Peerflix", description: "Separacion [HDTV 1080p][Cap.201]" },
      { type: "series" },
    );
    expect([p.season, p.episode]).toEqual([2, 1]);
  });

  it("reads a season then a bare episode number, but not a range", () => {
    const one = parseStream(
      { description: "[Group] Some Show S1 - 01 [1080p].mkv" },
      { type: "series" },
    );
    expect([one.season, one.episode, one.pack]).toEqual([1, 1, false]);
    const range = parseStream(
      { description: "[Group] Some Show S1+S2 - 01-38 (BD 1280x720 x264 AAC)" },
      { type: "series" },
    );
    expect([range.season, range.episode, range.pack]).toEqual([1, null, true]);
  });

  it("reads absolute episode numbers between underscores", () => {
    const p = parseStream({ description: "Some_Show_-_07_[720p].mkv" }, { type: "series" });
    expect([p.season, p.episode]).toEqual([null, 7]);
  });

  it("reads a TS screener as low quality", () => {
    const p = parseStream(
      { description: "Some Film (2026) TSScreener Latino.mp4" },
      { type: "movie" },
    );
    expect(p.source).toBe("scr");
  });

  it("reads a release that names no source but BD before its resolution", () => {
    expect(parseStream({ description: "[DB] Some Show - 01 [BD1080p HEVC FLAC]" }).source).toBe(
      "bluray",
    );
  });

  it("doesn't take a subtitle list for audio languages", () => {
    const p = parseStream(
      { description: "[Erai-raws] Some Show - 01 [1080p][ENG][POR-BR][SPA-LA][SPA][ARA][FRE].mkv" },
      { type: "series", anime: true },
    );
    expect(p.languages).toEqual([]);
    expect(p.group).toBe("Erai-raws");
  });

  it.each([
    ["Some Film 2026 1080p WEB-DL HEVC x265 10Bit DDP5.1 Subs KINGDOM.mkv", "KINGDOM"],
    ["Some Film (2023) 1080p H265 BluRay Rip ita eng AC3 5.1 sub ita eng Licdom.mkv", "Licdom"],
    ["Some.Show.S02E01.1080p.WEB.H264-FLUX-PSOTNIK HT.mkv", "PSOTNIK"],
    ["Some.Show.2023.S02.1080p.WEB-DL.H.264.Dual.YG⭐.mkv", "YG"],
    ["some.film.-2019.1080p.-blu-ray.-hindi.-dual-audio.x-265-katmovie-hd.nl.mkv", null],
    ["Some Film (2023) BluRay - 720p - x265 - HEVC - AAC - 1GB - ESub.mkv", null],
    ["Some.Film.2024.UHD.BluRay.2160p.DV.HEVC.HDR10+.TrueHD.Atmos.7.1.x265-E.mkv", null],
  ])("reads the group of %s as %s", (file, group) => {
    expect(parseStream({ description: file }, { type: "movie" }).group).toBe(group);
  });

  it("reads Peerflix's own fields", () => {
    const p = parseStream({
      name: "Peerflix",
      description: "Some Film [1080p]",
      language: "es",
      seed: 12,
      sizebytes: 2 ** 30,
    });
    expect(p).toMatchObject({ languages: ["es"], seeders: 12, sizeBytes: 2 ** 30 });
  });

  it("says nothing for a stream that says nothing", () => {
    expect(parseStream({ url: "https://example.invalid/video" })).toMatchObject({
      resolution: null,
      hdr: [],
      source: null,
      sizeBytes: null,
      languages: [],
      cached: null,
      fileName: null,
    });
  });
});
