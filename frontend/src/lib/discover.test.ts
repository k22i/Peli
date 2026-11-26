import { describe, expect, it } from "vite-plus/test";

import type { LibraryItem } from "@bindings/store";
import type { MetaPreview } from "@/lib/addon-protocol";
import { recentEpisodes, type CalendarShow } from "@/lib/calendar";
import { recentLimit, withRecent, withoutRecent } from "@/lib/recent-searches";
import { filterGroups, searchSearch, type SearchGroup } from "@/lib/search";
import { pickUnwatched, surprise } from "@/lib/surprise";

const day = 86_400_000;
const now = Date.parse("2026-11-11T12:00:00Z");
const at = (days: number) => new Date(now - days * day).toISOString();

const show = (name: string, ...released: (string | undefined)[]): CalendarShow => ({
  item: { contentId: name, contentType: "series", name, addedAt: 1 },
  meta: {
    id: name,
    type: "series",
    name,
    videos: released.map((date, i) =>
      Object.assign(
        {
          id: `${name}:${i}`,
          title: `E${i + 1}`,
          season: i === 0 && date === at(3) ? 0 : 1,
          episode: i + 1,
        },
        date ? { released: date } : {},
      ),
    ),
  },
});

describe("recentEpisodes", () => {
  it("keeps a show's latest episode from the last 7 days, newest first", () => {
    const out = recentEpisodes(
      [
        show("B", at(6), at(4)),
        show("A", at(2)),
        show("Old", at(8)),
        show("Future", new Date(now + day).toISOString()),
        show("Undated", undefined),
      ],
      now,
    );
    expect(out.map((entry) => entry.item.name)).toEqual(["A", "B"]);
    expect(out[1]!.episode.episode).toBe(2);
  });

  it("leaves out specials and puts same-time episodes on one card", () => {
    expect(recentEpisodes([show("Specials", at(3))], now)).toEqual([]);
    const [entry] = recentEpisodes([show("Drop", at(2), at(2), at(2))], now);
    expect(entry!.episodes).toHaveLength(3);
  });
});

const group = (kind: string, metas: Partial<MetaPreview>[]): SearchGroup => ({
  kind,
  title: kind,
  addons: [],
  metas: metas.map((meta, i) => ({ id: `${kind}${i}`, type: kind, name: "x", ...meta })),
});

describe("filterGroups", () => {
  const groups = [
    group("movie", [
      { releaseInfo: "1984", genres: ["Sci-Fi"] },
      { releaseInfo: "2024", genres: ["Drama"] },
      {},
    ]),
    group("series", [{ releaseInfo: "2021–2023", genres: ["drama"] }]),
  ];

  it("narrows by kind, decade and genre, dropping empty groups", () => {
    expect(filterGroups(groups, { type: "series" }).map((g) => g.kind)).toEqual(["series"]);
    expect(filterGroups(groups, { year: "2020" }).flatMap((g) => g.metas)).toHaveLength(2);
    expect(filterGroups(groups, { year: "older" }).flatMap((g) => g.metas)).toHaveLength(1);
    expect(filterGroups(groups, { genre: "Drama" }).flatMap((g) => g.metas)).toHaveLength(2);
    expect(filterGroups(groups, { year: "2000" })).toEqual([]);
    expect(filterGroups(groups, {})).toEqual(groups);
  });
});

describe("searchSearch", () => {
  it("keeps a valid kind, decade and genre, and drops the rest", () => {
    expect(searchSearch({ q: "x", type: "anime", year: 2010, genre: "Drama" })).toEqual({
      q: "x",
      type: "anime",
      year: "2010",
      genre: "Drama",
    });
    expect(searchSearch({ type: "tv", year: "1985", genre: " " })).toEqual({});
  });
});

describe("recent searches", () => {
  it("keeps the newest first, once each, up to the limit", () => {
    expect(withRecent(withRecent([], "dune"), "arrival")).toEqual(["arrival", "dune"]);
    expect(withRecent(["arrival", "dune"], "DUNE")).toEqual(["DUNE", "arrival"]);
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = withRecent(list, `q${i}`);
    expect(list).toHaveLength(recentLimit);
    expect(list[0]).toBe("q11");
    expect(withoutRecent(list, "q11")[0]).toBe("q10");
  });
});

const lib = (id: string) =>
  ({ contentId: id, contentType: "movie", name: id, addedAt: 1 }) as LibraryItem;

describe("surprise", () => {
  it("only picks what isn't watched, library first", () => {
    const watched = new Set(["a", "c"]);
    expect(
      pickUnwatched(
        ["a", "b", "c"],
        (x) => x,
        watched,
        () => 0.99,
      ),
    ).toBe("b");
    expect(
      surprise([lib("a"), lib("b")], [{ id: "z", type: "movie", name: "Z" }], watched),
    ).toEqual({
      from: "library",
      item: lib("b"),
    });
    expect(surprise([lib("a")], [{ id: "z", type: "movie", name: "Z" }], watched)).toMatchObject({
      from: "catalog",
    });
    expect(surprise([lib("a")], [], watched)).toBeUndefined();
  });
});
