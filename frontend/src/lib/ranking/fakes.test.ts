import { describe, expect, it } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import type { EpisodeMap, TitleContext } from "./context";
import { judge } from "./fakes";
import { parseStream } from "./parse";

// Long-running anime asked for by Kitsu's absolute number (#100, ADR-0050).
// One Piece episode 1100 is season 22, episode 15 by season.
const map: EpisodeMap = { season: 22, episode: 15, absolute: 1100 };
const onePiece: TitleContext = {
  type: "series",
  anime: true,
  id: "kitsu:12:1100",
  name: "One Piece",
  year: 1999,
  runtimeMin: 24,
  episode: 1100,
};
const mapped: TitleContext = { ...onePiece, map };

// A P2P answer: the torrent's name, then the file inside it.
const answer = (torrent: string, file?: string, size = "700 MB"): Stream => ({
  name: "Torrentio\n1080p",
  description: `${torrent}\n${file ? `${file}\n` : ""}👤 20 💾 ${size} ⚙️ NyaaSi`,
  infoHash: "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6",
  fileIdx: 0,
  behaviorHints: { filename: file ?? torrent },
});

const verdict = (stream: Stream, ctx: TitleContext) =>
  judge(parseStream(stream, { type: ctx.type, anime: ctx.anime }), ctx);

describe("Kitsu episodes with an episode map", () => {
  it("keeps S22E15 for episode 1100, the same episode numbered by season", () => {
    const stream = answer(
      "One Piece S22 1080p CR WEB-DL AAC2.0 AV1-knyf1e",
      "One Piece AKA Wan pîsu S22E15 1080p CR AAC 2.0 AV1-knyf1e.mkv",
    );
    expect(verdict(stream, mapped).bucket).toBe("ok");
    expect(verdict(stream, onePiece).bucket).toBe("ok");
  });

  it.each([
    ["absolute number", "[SubsPlease] One Piece - 1100 (1080p) [ABCD1234].mkv"],
    ["absolute number in season 1", "One.Piece.S01E1100.KOREAN.1080p.JBOX.WEB-DL.H264-R1.mkv"],
    ["absolute number in a folder season", "Season 20 - Wano/[Anime Time] One Piece - 1100.mkv"],
  ])("keeps %s", (_, file) => {
    expect(verdict(answer(file), mapped).bucket).toBe("ok");
  });

  it("hides season packs of other seasons", () => {
    const pack = answer("One Piece S01 (East Blue) 1080p", undefined, "21.3 GB");
    expect(verdict(pack, mapped)).toEqual({ bucket: "hidden", reasons: ["wrong season"] });
    // Without a map a pack can't be judged.
    expect(verdict(pack, onePiece).bucket).toBe("ok");
  });

  it("keeps the season's own pack, and packs whose range covers the episode", () => {
    for (const name of [
      "One Piece S22 1080p WEB-DL",
      "One Piece (1999) S01-S22 DUAL Mixed",
      "One Piece Seasons 16 to 22 1080p",
      "One.Piece.S01E40-E1200",
      "One Piece S01 [0001-1118] 1080p",
    ]) {
      expect([name, verdict(answer(name, undefined, "40 GB"), mapped).bucket]).toEqual([
        name,
        "ok",
      ]);
    }
  });

  it("hides packs whose range ends before the episode", () => {
    for (const name of ["One Piece S01-S18 English Audio", "One Piece S01-S21 1080p CR"]) {
      expect([name, verdict(answer(name, undefined, "40 GB"), mapped).reasons]).toEqual([
        name,
        ["wrong season"],
      ]);
    }
  });

  it("hides another season's episode", () => {
    const stream = answer("One Piece S20 1080p", "One Piece - S20E15 - Wano.mkv");
    expect(verdict(stream, mapped)).toEqual({ bucket: "hidden", reasons: ["wrong season"] });
    // Today's rule can't tell: season 20 isn't the episode's number.
    expect(verdict(stream, onePiece).bucket).toBe("ok");
  });

  it("hides another episode of the right season, and of no season", () => {
    expect(verdict(answer("x", "One Piece - S22E16.mkv"), mapped).reasons).toEqual([
      "wrong episode",
    ]);
    expect(
      verdict(answer("x", "[SubsPlease] One Piece - 1099 (1080p).mkv"), mapped).reasons,
    ).toEqual(["wrong episode"]);
  });

  it("tells a season-relative number from the absolute one", () => {
    // Dandadan's second season is Kitsu id 49425: episode 1 is S02E01, or 13.
    const second: TitleContext = {
      ...onePiece,
      id: "kitsu:49425:1",
      name: "Dandadan 2nd Season",
      episode: 1,
      map: { season: 2, episode: 1, absolute: 13 },
    };
    expect(verdict(answer("x", "Dandadan S02E01.mkv"), second).bucket).toBe("ok");
    expect(verdict(answer("x", "Dandadan - 13 [1080p].mkv"), second).bucket).toBe("ok");
    expect(
      verdict(answer("x", "[Erai-raws] Dandadan 2nd Season - 01 [1080p].mkv"), second).bucket,
    ).toBe("ok");
    expect(verdict(answer("x", "Dandadan S01E01.mkv"), second).reasons).toEqual(["wrong season"]);
  });
});

describe("Kitsu episodes without an episode map", () => {
  it("keeps today's rules: what can't be judged isn't flagged", () => {
    expect(verdict(answer("One Piece S01 (East Blue)", undefined, "21 GB"), onePiece).bucket).toBe(
      "ok",
    );
    expect(verdict(answer("x", "One Piece - S22E15.mkv"), onePiece).bucket).toBe("ok");
    expect(
      verdict(answer("x", "[SubsPlease] One Piece - 1099 (1080p).mkv"), onePiece).reasons,
    ).toEqual(["wrong episode"]);
  });
});
