import { describe, expect, it, vi } from "vite-plus/test";

import type { Track } from "@/lib/player";
import {
  autoSecondary,
  autoSubtitle,
  byLanguage,
  isPictureSubtitle,
  isTextSubtitle,
  secondChoices,
  smartSubtitle,
  subtitleLanguage,
  subtitleTarget,
  syncSummary,
  textInstead,
  wantedSubtitleLanguage,
  type AddonSubtitle,
} from "@/lib/subtitles";

describe("syncSummary", () => {
  it("says how far synced subtitles moved", () => {
    expect(syncSummary({ status: "synced", firstShift: 3.21, lastShift: 3.3 })).toEqual({
      title: "Synced to this video",
      detail: "Moved 3.2 s later, to match the subtitles this video comes with.",
      synced: true,
    });
  });

  it("names a frame-rate fix by its two ends", () => {
    expect(syncSummary({ status: "synced", firstShift: -1, lastShift: 6.8 })?.detail).toBe(
      "Moved 1.0 s earlier at the start and 6.8 s later by the end: they were made for another frame rate.",
    );
  });

  it("says why nothing moved, and nothing for a track that wasn't tried", () => {
    const none = { firstShift: 0, lastShift: 0 };
    expect(syncSummary({ status: "inSync", ...none })?.title).toBe("Already in sync");
    expect(syncSummary({ status: "noMatch", ...none })?.title).toBe("Couldn’t sync these");
    expect(syncSummary({ status: "noReference", ...none })?.detail).toMatch(
      /no subtitles of its own/,
    );
    expect(syncSummary({ status: "unchecked", ...none })?.synced).toBe(false);
    expect(syncSummary({ status: "", ...none })).toBeUndefined();
    expect(syncSummary(undefined)).toBeUndefined();
  });
});

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

  it("adds text when the file's own in the language are only pictures", () => {
    const pgs = sub("eng", { codec: "hdmv_pgs_subtitle", hearingImpaired: true });
    expect(autoSubtitle(list, [pgs], "en", true)?.key).toBe("en1");
    expect(autoSubtitle(list, [pgs, sub("eng", { id: 2 })], "en", true)).toBeUndefined();
  });
});

describe("picture subtitles", () => {
  const pgs = sub("eng", { id: 1, codec: "hdmv_pgs_subtitle", hearingImpaired: true });

  it("tells pictures from text", () => {
    expect(isPictureSubtitle(pgs)).toBe(true);
    expect(isPictureSubtitle(sub("en", { codec: "dvd_subtitle" }))).toBe(true);
    expect(isPictureSubtitle(sub("en"))).toBe(false);
    expect(isPictureSubtitle(sub("en", { codec: "ass" }))).toBe(false);
    expect(isPictureSubtitle(sub("en", { type: "audio", codec: "hdmv_pgs_subtitle" }))).toBe(false);
  });

  describe("textInstead", () => {
    it("is the file's own text track in the language, as hearing-impaired as the picture", () => {
      const plain = sub("en", { id: 2 });
      const sdh = sub("en", { id: 3, hearingImpaired: true });
      expect(textInstead(pgs, [pgs, plain, sdh], [])).toEqual({ track: sdh });
      expect(textInstead(pgs, [pgs, plain], [subtitle("a", "eng")])).toEqual({ track: plain });
    });

    it("else an addon's in the language", () => {
      const addon = subtitle("b", "eng");
      expect(textInstead(pgs, [pgs, sub("fr", { id: 2 })], [subtitle("a", "hrv"), addon])).toEqual({
        addon,
      });
    });

    it("is nothing for text, signs, an untagged picture, or no text to offer", () => {
      expect(textInstead(sub("en"), [sub("en", { id: 2 })], [])).toBeUndefined();
      const signs = sub("en", { codec: "hdmv_pgs_subtitle", forced: true });
      expect(textInstead(signs, [sub("en", { id: 2 })], [])).toBeUndefined();
      const untagged = sub("", { codec: "hdmv_pgs_subtitle" });
      expect(textInstead(untagged, [sub("", { id: 2 })], [])).toBeUndefined();
      expect(textInstead(pgs, [pgs, sub("en", { id: 4, forced: true })], [])).toBeUndefined();
    });
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

describe("subtitles always on", () => {
  describe("smartSubtitle", () => {
    it("picks the file's own text track in the wanted language over a picture one", () => {
      const pgs = sub("en", { id: 1, codec: "hdmv_pgs_subtitle" });
      const text = sub("eng", { id: 2 });
      expect(smartSubtitle([pgs, text], [], "en")).toEqual({ track: text });
    });

    it("skips forced tracks, which only translate signs", () => {
      const signs = sub("en", { id: 1, forced: true });
      const full = sub("en", { id: 2 });
      expect(smartSubtitle([signs, full], [], "en")).toEqual({ track: full });
      expect(smartSubtitle([signs], [], "en")).toBeUndefined();
    });

    it("prefers full subtitles over hearing-impaired ones, and the default-flagged first", () => {
      const sdh = sub("en", { id: 1, hearingImpaired: true });
      const plain = sub("en", { id: 2 });
      expect(smartSubtitle([sdh, plain], [], "en")).toEqual({ track: plain });
      const other = sub("en", { id: 3 });
      const flagged = sub("en", { id: 4, default: true });
      expect(smartSubtitle([other, flagged], [], "en")).toEqual({ track: flagged });
    });

    it("picks an addon's text over the file's own picture track, and the picture over none", () => {
      const pgs = sub("en", { id: 1, codec: "hdmv_pgs_subtitle", default: true });
      const addon = subtitle("a", "eng");
      expect(smartSubtitle([pgs], [addon], "en")).toEqual({ addon });
      expect(smartSubtitle([pgs], [subtitle("b", "hrv")], "en")).toEqual({ track: pgs });
    });

    it("falls back to an addon's subtitles in the wanted language", () => {
      const addon = subtitle("a", "pob");
      const tracks = [sub("eng", { id: 1 })];
      expect(smartSubtitle(tracks, [subtitle("b", "eng"), addon], "pt")).toEqual({ addon });
    });

    it("falls back to the file's only full track with no language tag", () => {
      const untagged = sub("", { id: 1 });
      expect(smartSubtitle([sub("eng", { id: 2 }), untagged], [], "pt")).toEqual({
        track: untagged,
      });
      // Two of them are no choice at all.
      expect(smartSubtitle([untagged, sub("und", { id: 3 })], [], "pt")).toBeUndefined();
    });

    it("has nothing when nothing fits", () => {
      expect(smartSubtitle([sub("eng")], [], "pt")).toBeUndefined();
      expect(smartSubtitle([], [], "en")).toBeUndefined();
      expect(
        smartSubtitle([sub("en", { forced: true })], [subtitle("a", "hrv")], "en"),
      ).toBeUndefined();
      expect(smartSubtitle([sub("en", { id: 1 })], [subtitle("a", "eng")], "")).toBeUndefined();
    });
  });

  describe("wantedSubtitleLanguage", () => {
    const nothing = { subtitleLanguage: "", audioLanguages: [] };

    it("is the profile's subtitle language first, then its first audio language", () => {
      expect(wantedSubtitleLanguage({ subtitleLanguage: "ja", audioLanguages: ["fr", "de"] })).toBe(
        "ja",
      );
      expect(wantedSubtitleLanguage({ subtitleLanguage: "", audioLanguages: ["pt"] })).toBe("pt");
    });

    it("falls back to the system's language, then English", () => {
      const language = vi.spyOn(navigator, "language", "get").mockReturnValue("vi-VN");
      try {
        expect(wantedSubtitleLanguage(nothing)).toBe("vi");
        // A system language that isn't an ISO 639 code leaves English.
        language.mockReturnValue("");
        expect(wantedSubtitleLanguage(nothing)).toBe("en");
        expect(wantedSubtitleLanguage(undefined)).toBe("en");
      } finally {
        language.mockRestore();
      }
    });
  });
});
