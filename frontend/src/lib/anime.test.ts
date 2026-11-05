import { describe, expect, it } from "vite-plus/test";

import { imdbOf, isListedAnime } from "./anime";

describe("isListedAnime", () => {
  const ids = new Set(["tt0388629"]);

  it("knows a title and its episodes by IMDb id", () => {
    expect(imdbOf("tt0388629:1:1")).toBe("tt0388629");
    expect(isListedAnime(ids, "tt0388629")).toBe(true);
    expect(isListedAnime(ids, "tt0388629:1:1")).toBe(true);
  });

  it("leaves everything else, and everything while the list isn't there", () => {
    expect(isListedAnime(ids, "tt0903747")).toBe(false);
    expect(isListedAnime(ids, "kitsu:12")).toBe(false);
    expect(isListedAnime(undefined, "tt0388629")).toBe(false);
  });
});
