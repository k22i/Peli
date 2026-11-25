import { describe, expect, it } from "vite-plus/test";

import type { Channel, Programme } from "@bindings/livetv";
import {
  blocksFor,
  channelsIn,
  clockLabel,
  favouritesGroup,
  groupKey,
  groupLabel,
  groupsOf,
  guideRange,
  neighbourChannel,
  offsetOf,
  otherGroup,
  progressOf,
  slotMs,
  slotsOf,
  type GuideBlock,
} from "@/lib/livetv";

// A channel as a playlist gives one: the test names the id and name, and the
// rest comes from here unless the test says otherwise.
const channel = (fields: Partial<Channel> & Pick<Channel, "id" | "name">): Channel => ({
  id: fields.id,
  name: fields.name,
  sourceId: fields.sourceId ?? "src",
  number: fields.number ?? 1,
  logo: fields.logo ?? "",
  group: fields.group ?? "",
  tvgId: fields.tvgId ?? "",
  tvgName: fields.tvgName ?? "",
});

const programme = (
  fields: Partial<Programme> & Pick<Programme, "start" | "stop" | "title">,
): Programme => ({
  channelId: fields.channelId ?? "a",
  start: fields.start,
  stop: fields.stop,
  title: fields.title,
  subTitle: fields.subTitle ?? "",
  description: fields.description ?? "",
  categories: fields.categories ?? [],
  episode: fields.episode ?? "",
  icon: fields.icon ?? "",
});

// UTC, so the tests don't depend on the time zone: the guide's maths is on ms.
const at = (hours: number, minutes = 0) => Date.UTC(2026, 10, 25, hours, minutes);

const names = (channels: Channel[]) => channels.map((entry) => entry.name);

describe("groupKey", () => {
  it("treats a blank group as Other", () => {
    expect(groupKey(channel({ id: "a", name: "A" }))).toBe(otherGroup);
    expect(groupKey(channel({ id: "b", name: "B", group: "   " }))).toBe(otherGroup);
  });

  it("trims a group the playlist padded", () => {
    expect(groupKey(channel({ id: "a", name: "A", group: " News " }))).toBe("News");
  });
});

describe("groupsOf", () => {
  it("keeps first-appearance order with Other last", () => {
    const groups = groupsOf([
      channel({ id: "a", name: "A", group: "News" }),
      channel({ id: "b", name: "B" }),
      channel({ id: "c", name: "C", group: "Sport" }),
      channel({ id: "d", name: "D", group: "News" }),
    ]);
    expect(groups).toEqual(["News", "Sport", otherGroup]);
  });

  it("leaves out the favourites, which the page keeps itself", () => {
    expect(
      groupsOf([
        channel({ id: "a", name: "A", group: favouritesGroup }),
        channel({ id: "b", name: "B", group: "News" }),
      ]),
    ).toEqual(["News"]);
  });

  it("has nothing for no channels", () => {
    expect(groupsOf([])).toEqual([]);
  });
});

describe("groupLabel", () => {
  it("names the special groups and leaves the playlist's alone", () => {
    expect(groupLabel(favouritesGroup)).toBe("Favourites");
    expect(groupLabel(otherGroup)).toBe("Other");
    expect(groupLabel("")).toBe("All");
    expect(groupLabel("News")).toBe("News");
  });
});

describe("channelsIn", () => {
  const channels = [
    channel({ id: "a", name: "News", number: 101, group: "News" }),
    channel({ id: "b", name: "Café TV", number: 12 }),
    channel({ id: "c", name: "Sport", number: 3, group: "Sport" }),
  ];

  it("keeps every channel when there is no group", () => {
    const all = channelsIn(channels, undefined, [], "");
    expect(names(all)).toEqual(["News", "Café TV", "Sport"]);
    expect(names(channelsIn(channels, "", [], ""))).toEqual(["News", "Café TV", "Sport"]);
    expect(all).not.toBe(channels);
  });

  it("keeps one group's channels in playlist order", () => {
    expect(names(channelsIn(channels, "Sport", [], ""))).toEqual(["Sport"]);
  });

  it("puts the favourites in the profile's order and skips ids it no longer has", () => {
    expect(names(channelsIn(channels, favouritesGroup, ["c", "gone", "a"], ""))).toEqual([
      "Sport",
      "News",
    ]);
  });

  it("finds a name whatever its case and accents", () => {
    expect(names(channelsIn(channels, undefined, [], "cafe"))).toEqual(["Café TV"]);
    expect(names(channelsIn(channels, undefined, [], "CAFÉ"))).toEqual(["Café TV"]);
  });

  it("finds a channel by its number", () => {
    expect(names(channelsIn(channels, undefined, [], "12"))).toEqual(["Café TV"]);
  });

  it("ignores a blank filter", () => {
    expect(names(channelsIn(channels, "Sport", [], "   "))).toEqual(["Sport"]);
  });
});

describe("neighbourChannel", () => {
  const channels = [
    channel({ id: "a", name: "A" }),
    channel({ id: "b", name: "B" }),
    channel({ id: "c", name: "C" }),
  ];

  it("steps forward and back", () => {
    expect(neighbourChannel(channels, "a", 1)?.id).toBe("b");
    expect(neighbourChannel(channels, "b", -1)?.id).toBe("a");
  });

  it("wraps round both ends", () => {
    expect(neighbourChannel(channels, "c", 1)?.id).toBe("a");
    expect(neighbourChannel(channels, "a", -1)?.id).toBe("c");
  });

  it("steps in from the end it comes from when the current channel is missing", () => {
    expect(neighbourChannel(channels, "gone", 1)?.id).toBe("a");
    expect(neighbourChannel(channels, "gone", -1)?.id).toBe("c");
  });

  it("has nowhere to go in a list of one", () => {
    expect(neighbourChannel([channel({ id: "a", name: "A" })], "a", 1)).toBeUndefined();
  });

  it("has nothing for no channels", () => {
    expect(neighbourChannel([], "a", 1)).toBeUndefined();
  });
});

describe("progressOf", () => {
  const entry = programme({ start: at(21, 0), stop: at(22, 0), title: "Programme" });

  it("is nothing before the programme starts", () => {
    expect(progressOf(entry, at(20, 30))).toBe(0);
  });

  it("is halfway through the middle", () => {
    expect(progressOf(entry, at(21, 30))).toBe(0.5);
  });

  it("is all the way through after it ends", () => {
    expect(progressOf(entry, at(23, 0))).toBe(1);
  });

  it("is nothing for a programme with no length", () => {
    const empty = programme({ start: at(21, 0), stop: at(21, 0), title: "Empty" });
    expect(progressOf(empty, at(21, 0))).toBe(0);
  });
});

describe("guideRange", () => {
  it("starts a slot before the current half hour and runs 36 hours on", () => {
    expect(guideRange(at(21, 47))).toEqual({
      from: at(21, 0),
      to: at(21, 30) + 36 * 60 * 60_000,
    });
  });
});

describe("slotsOf", () => {
  it("starts on the first half hour at or after from", () => {
    expect(slotsOf(at(21, 0), at(21, 0) + 2 * slotMs)).toEqual([at(21, 0), at(21, 30)]);
  });

  it("skips ahead to the half hour when from is not on one", () => {
    expect(slotsOf(at(21, 7), at(21, 0) + 2 * slotMs)).toEqual([at(21, 30)]);
  });

  it("has nothing when the range is empty or backwards", () => {
    expect(slotsOf(at(21, 0), at(21, 0))).toEqual([]);
    expect(slotsOf(at(21, 30), at(21, 0))).toEqual([]);
  });
});

describe("offsetOf", () => {
  it("is the minutes from the start at so many px a minute", () => {
    expect(offsetOf(at(21, 0), at(20, 30), 2)).toBe(60);
  });
});

describe("blocksFor", () => {
  const from = at(20, 30);
  const to = at(22, 30);
  const shape = (blocks: GuideBlock[]) =>
    blocks.map((block) => [
      block.programme.title,
      block.left,
      block.width,
      block.clippedStart,
      block.clippedEnd,
    ]);

  it("clips a programme that overruns either end and says which", () => {
    const blocks = blocksFor(
      [
        programme({ start: at(20, 0), stop: at(21, 0), title: "Early" }),
        programme({ start: at(22, 0), stop: at(23, 0), title: "Late" }),
      ],
      from,
      to,
      1,
    );
    expect(shape(blocks)).toEqual([
      ["Early", 0, 30, true, false],
      ["Late", 90, 30, false, true],
    ]);
  });

  it("drops a programme outside the range", () => {
    const blocks = blocksFor(
      [
        programme({ start: at(19, 0), stop: from, title: "Before" }),
        programme({ start: to, stop: at(23, 0), title: "After" }),
      ],
      from,
      to,
      1,
    );
    expect(blocks).toEqual([]);
  });

  it("draws them in start order, however they arrive", () => {
    const blocks = blocksFor(
      [
        programme({ start: at(21, 30), stop: at(22, 0), title: "Second" }),
        programme({ start: at(20, 30), stop: at(21, 30), title: "First" }),
      ],
      from,
      to,
      1,
    );
    expect(shape(blocks)).toEqual([
      ["First", 0, 60, false, false],
      ["Second", 60, 30, false, false],
    ]);
  });

  it("shortens the earlier programme where the guide overlaps itself", () => {
    const blocks = blocksFor(
      [
        programme({ start: at(20, 30), stop: at(21, 30), title: "Long" }),
        programme({ start: at(21, 0), stop: at(22, 0), title: "Late" }),
      ],
      from,
      to,
      1,
    );
    expect(shape(blocks)).toEqual([
      ["Long", 0, 30, false, false],
      ["Late", 30, 60, false, false],
    ]);
  });

  it("drops the earlier programme when the later one covers it whole", () => {
    const blocks = blocksFor(
      [
        programme({ start: at(21, 0), stop: at(22, 0), title: "Whole" }),
        programme({ start: at(21, 0), stop: at(21, 30), title: "Hidden" }),
      ],
      from,
      to,
      1,
    );
    expect(shape(blocks)).toEqual([["Hidden", 30, 30, false, false]]);
  });
});

describe("clockLabel", () => {
  const ms = Date.UTC(2026, 10, 25, 21, 30);
  const format = (locale: string) =>
    new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(ms);

  it("names the time the way the locale does", () => {
    expect(clockLabel(ms, "en-GB")).toBe(format("en-GB"));
  });

  it("keeps one formatter per locale", () => {
    expect(clockLabel(ms, "en-GB")).toBe(format("en-GB"));
    expect(clockLabel(ms, "en-US")).toBe(format("en-US"));
    expect(clockLabel(ms, "en-GB")).toBe(format("en-GB"));
  });
});
