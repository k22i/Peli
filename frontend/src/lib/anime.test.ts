import { describe, expect, it } from "vite-plus/test";

import { imdbOf } from "./anime";

describe("imdbOf", () => {
  it("knows a title and its episodes by IMDb id", () => {
    expect(imdbOf("tt0388629:1:1")).toBe("tt0388629");
    expect(imdbOf("tt0388629")).toBe("tt0388629");
    expect(imdbOf("kitsu:12")).toBeUndefined();
  });
});
