import { describe, expect, it } from "vite-plus/test";

import { sharper } from "@/lib/artwork-url";

const poster = "https://images.metahub.space/poster/small/tt0111161/img";
const background = "https://images.metahub.space/background/small/tt0111161/img";
const logo = "https://images.metahub.space/logo/medium/tt0111161/img";

describe("sharper", () => {
  it("asks Metahub for medium posters on poster cards", () => {
    expect(sharper(poster, "poster")).toBe(
      "https://images.metahub.space/poster/medium/tt0111161/img",
    );
    expect(sharper("https://live.metahub.space/poster/small/tt14828040/img", "poster")).toBe(
      "https://live.metahub.space/poster/medium/tt14828040/img",
    );
    // Already big enough.
    const medium = "https://images.metahub.space/poster/medium/tt0903747/img";
    expect(sharper(medium, "poster")).toBe(medium);
  });

  it("asks for medium backgrounds on landscape cards only", () => {
    expect(sharper(background, "landscape")).toBe(
      "https://images.metahub.space/background/medium/tt0111161/img",
    );
    // Hero backdrops stay as they are.
    expect(sharper(background, "backdrop")).toBe(background);
    const medium = "https://images.metahub.space/background/medium/tt0111161/img";
    expect(sharper(medium, "landscape")).toBe(medium);
  });

  it("asks for a large logo on a logo", () => {
    expect(sharper(logo, "logo")).toBe("https://images.metahub.space/logo/large/tt0111161/img");
    expect(sharper(logo, "poster")).toBe(logo);
  });

  it("leaves a Metahub image of another kind than the use alone", () => {
    expect(sharper(poster, "landscape")).toBe(poster);
    expect(sharper(background, "poster")).toBe(background);
    const large = "https://images.metahub.space/poster/large/tt1/img";
    expect(sharper(large, "poster")).toBe(large);
  });

  it("raises TMDB posters to w500, stills to w780 and cast photos to w342", () => {
    expect(sharper("https://image.tmdb.org/t/p/w342/a.jpg", "poster")).toBe(
      "https://image.tmdb.org/t/p/w500/a.jpg",
    );
    expect(sharper("https://image.tmdb.org/t/p/w300/s.jpg", "landscape")).toBe(
      "https://image.tmdb.org/t/p/w780/s.jpg",
    );
    expect(sharper("https://image.tmdb.org/t/p/w185/tim.jpg", "avatar")).toBe(
      "https://image.tmdb.org/t/p/w342/tim.jpg",
    );
  });

  it("never steps a TMDB image down, and leaves original, logos and backdrops alone", () => {
    expect(sharper("https://image.tmdb.org/t/p/original/back.jpg", "poster")).toBe(
      "https://image.tmdb.org/t/p/original/back.jpg",
    );
    expect(sharper("https://image.tmdb.org/t/p/w780/a.jpg", "poster")).toBe(
      "https://image.tmdb.org/t/p/w780/a.jpg",
    );
    expect(sharper("https://image.tmdb.org/t/p/w500/en.png", "logo")).toBe(
      "https://image.tmdb.org/t/p/w500/en.png",
    );
    expect(sharper("https://image.tmdb.org/t/p/w300/a.jpg", "backdrop")).toBe(
      "https://image.tmdb.org/t/p/w300/a.jpg",
    );
  });

  it("passes anything else through", () => {
    const kitsu = "https://media.kitsu.app/anime/46474/poster_image/medium-23e1.jpeg";
    expect(sharper(kitsu, "poster")).toBe(kitsu);
    expect(sharper(undefined, "poster")).toBeUndefined();
    expect(sharper("", "poster")).toBe("");
  });
});
