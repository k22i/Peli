import { describe, expect, it } from "vite-plus/test";

import type { Track } from "@/lib/player";
import {
  autoSecondary,
  autoSubtitle,
  byLanguage,
  isTextSubtitle,
  secondChoices,
  subtitleLanguage,
  subtitleTarget,
  type AddonSubtitle,
} from "@/lib/subtitles";

const subtitle = (key: string, lang: string): AddonSubtitle => ({
  key,
  url: `https://subs.example/${key}.srt`,
  ...subtitleLanguage(lang),
  name: "",
  addon: "OpenSubtitles v3",
});

const sub = (lang: string, fields: Partial<Track> = {}): Track => ({
  id: 1,
  type: "sub",
  title: "",
  lang,
  codec: "subrip",
  default: false,
  selected: false,
  secondary: false,
  external: false,
  forced: false,
  hearingImpaired: false,
  ...fields,
});

describe("subtitleLanguage", () => {
  it("reads ISO 639 codes, OpenSubtitles' own, and anything else", () => {
    expect(subtitleLanguage("eng")).toEqual({ language: "en", code: "en" });
    expect(subtitleLanguage("en")).toEqual({ language: "en", code: "en" });
    expect(subtitleLanguage("pob")).toEqual({ language: "pt-BR", code: "pt" });
    expect(subtitleLanguage("zht")).toEqual({ language: "zh-Hant", code: "zh" });
    expect(subtitleLanguage("hrv")).toEqual({ language: "hr", code: "hr" });
    expect(subtitleLanguage("und")).toEqual({ language: "und", code: "" });
    expect(subtitleLanguage("English (SDH)")).toEqual({ language: "english (sdh)", code: "" });
  });
});

describe("byLanguage", () => {
  it("puts the profile's language first, then the rest by name, in addon order", () => {
    const groups = byLanguage(
      [
        subtitle("a", "hrv"),
        subtitle("b", "pob"),
        subtitle("c", "eng"),
        subtitle("d", "por"),
        subtitle("e", "pob"),
      ],
      "pt",
    );
    expect(groups.map((group) => [group.label, group.subtitles.map((each) => each.key)])).toEqual([
      ["Portuguese", ["d"]],
      ["Brazilian Portuguese", ["b", "e"]],
      ["Croatian", ["a"]],
      ["English", ["c"]],
    ]);
  });
});

describe("autoSubtitle", () => {
  const list = [subtitle("hr", "hrv"), subtitle("en1", "eng"), subtitle("en2", "eng")];

  it("is the first in the profile's language when the file has none in it", () => {
    expect(autoSubtitle(list, [sub("jpn")], "en", true)?.key).toBe("en1");
    // Forced subtitles only translate signs.
    expect(autoSubtitle(list, [sub("eng", { forced: true })], "en", true)?.key).toBe("en1");
  });

  it("is none with captions off, no language, the file's own, or none in it", () => {
    expect(autoSubtitle(list, [], "en", false)).toBeUndefined();
    expect(autoSubtitle(list, [], "", true)).toBeUndefined();
    expect(autoSubtitle(list, [sub("eng")], "en", true)).toBeUndefined();
    expect(autoSubtitle(list, [], "fr", true)).toBeUndefined();
  });
});

describe("subtitleTarget", () => {
  it("passes on what the stream says of its file, and its own subtitles", () => {
    expect(
      subtitleTarget(
        "series",
        "tt0903747:1:1",
        {
          behaviorHints: { filename: "Breaking.Bad.S01E01.mkv", videoSize: 123, bingeGroup: "x" },
          subtitles: [{ id: "1", url: "https://subs.example/1.srt", lang: "eng" }],
        },
        "Torrentio",
      ),
    ).toEqual({
      type: "series",
      id: "tt0903747:1:1",
      extra: { filename: "Breaking.Bad.S01E01.mkv", videoSize: 123 },
      stream: {
        addon: "Torrentio",
        subtitles: [{ id: "1", url: "https://subs.example/1.srt", lang: "eng" }],
      },
    });
    expect(subtitleTarget("movie", "tt1", {}, "Torrentio")).toEqual({
      type: "movie",
      id: "tt1",
      extra: {},
    });
  });
});

describe("the second line of subtitles", () => {
  it("is for text, not pictures", () => {
    expect(isTextSubtitle(sub("en"))).toBe(true);
    expect(isTextSubtitle(sub("en", { codec: "hdmv_pgs_subtitle" }))).toBe(false);
    expect(isTextSubtitle(sub("en", { codec: "dvd_subtitle" }))).toBe(false);
    expect(isTextSubtitle(sub("en", { type: "audio" }))).toBe(false);
  });

  it("can be any text track but the main one", () => {
    const tracks = [
      sub("en", { id: 1 }),
      sub("ja", { id: 2 }),
      sub("fr", { id: 3, codec: "hdmv_pgs_subtitle" }),
      sub("de", { id: 4 }),
    ];
    expect(secondChoices(tracks, 1).map((track) => track.id)).toEqual([2, 4]);
    expect(secondChoices(tracks, 0).map((track) => track.id)).toEqual([1, 2, 4]);
  });

  describe("autoSecondary", () => {
    const tracks = [
      sub("en", { id: 1, selected: true }),
      sub("ja", { id: 2, forced: true }),
      sub("ja", { id: 3 }),
    ];

    it("picks the file's own track in the second language, not a forced one", () => {
      expect(autoSecondary(tracks, [], "ja", 1)).toEqual({ track: tracks[2] });
    });

    it("falls back to an addon's subtitles", () => {
      const addon = subtitle("a", "jpn");
      const own = [tracks[0]!];
      expect(autoSecondary(own, [subtitle("b", "eng"), addon], "ja", 1)).toEqual({ addon });
    });

    it("has nothing for a language nobody has", () => {
      expect(autoSecondary(tracks, [subtitle("b", "eng")], "ko", 1)).toBeUndefined();
    });

    it("waits for the main subtitles, and won't pair a language with itself", () => {
      expect(autoSecondary(tracks, [], "ja", 0)).toBeUndefined();
      expect(autoSecondary(tracks, [], "en", 1)).toBeUndefined();
      expect(autoSecondary(tracks, [], "", 1)).toBeUndefined();
    });

    it("is for full subtitles: nothing next to forced signs", () => {
      const signs = [sub("en", { id: 1, forced: true }), sub("ja", { id: 3 })];
      expect(autoSecondary(signs, [], "ja", 1)).toBeUndefined();
    });
  });
});
