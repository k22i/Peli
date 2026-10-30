import { describe, expect, it } from "vite-plus/test";

import type { Track } from "@/lib/player";
import {
  autoSubtitle,
  byLanguage,
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
