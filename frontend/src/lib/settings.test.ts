import { describe, expect, it } from "vite-plus/test";

import {
  addLanguage,
  audioLanguageLimit,
  displayModeOf,
  maxResolutionOf,
  moveLanguage,
  removeLanguage,
} from "./settings";

// #98: the audio languages are an ordered list.
describe("the audio language list", () => {
  it("adds a language at the end, once", () => {
    expect(addLanguage([], "ja")).toEqual(["ja"]);
    expect(addLanguage(["ja"], "en")).toEqual(["ja", "en"]);
    expect(addLanguage(["ja", "en"], "ja")).toEqual(["ja", "en"]);
    expect(addLanguage(["ja"], "")).toEqual(["ja"]);
  });

  it("stops adding at the limit", () => {
    const full = ["en", "es", "fr", "de", "it", "pt", "nl", "sv"];
    expect(full).toHaveLength(audioLanguageLimit);
    expect(addLanguage(full, "pl")).toEqual(full);
  });

  it("never changes the list it was given", () => {
    const list = ["ja", "en"];
    addLanguage(list, "ko");
    moveLanguage(list, "en", -1);
    removeLanguage(list, "ja");
    expect(list).toEqual(["ja", "en"]);
  });

  it("removes a language and keeps the order of the rest", () => {
    expect(removeLanguage(["ja", "en", "ko"], "en")).toEqual(["ja", "ko"]);
    expect(removeLanguage(["ja"], "en")).toEqual(["ja"]);
  });

  it("moves a language one place, and the ends stay put", () => {
    const list = ["ja", "en", "ko"];
    expect(moveLanguage(list, "ko", -1)).toEqual(["ja", "ko", "en"]);
    expect(moveLanguage(list, "ja", 1)).toEqual(["en", "ja", "ko"]);
    expect(moveLanguage(list, "ja", -1)).toEqual(list);
    expect(moveLanguage(list, "ko", 1)).toEqual(list);
    expect(moveLanguage(list, "fr", 1)).toEqual(list);
  });
});

describe("device choices", () => {
  it("reads a value this build doesn't know as Auto", () => {
    expect(maxResolutionOf({ maxResolution: "1080p" })).toBe("1080p");
    expect(maxResolutionOf({ maxResolution: "" })).toBe("auto");
    expect(maxResolutionOf({ maxResolution: "8k" })).toBe("auto");
    expect(maxResolutionOf(undefined)).toBe("auto");
    expect(displayModeOf("on")).toBe("on");
    expect(displayModeOf("")).toBe("auto");
    expect(displayModeOf(undefined)).toBe("auto");
  });
});
