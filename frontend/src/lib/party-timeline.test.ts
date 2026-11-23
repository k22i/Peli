import { describe, expect, it } from "vite-plus/test";

import {
  activityText,
  duration,
  partyTimeline,
  type Message,
  type TimelineItem,
} from "@/lib/party";
import { partyActivityEntry } from "@/test/fixtures";

// A message as the chat has it: sent by Ana, unless a test says otherwise.
function message(changes: Partial<Message> = {}): Message {
  return {
    key: "m1",
    memberId: "ana",
    name: "Ana",
    avatarUrl: "",
    avatarColor: "",
    body: "Ready when you are",
    sentAt: 0,
    mine: false,
    status: "sent",
    ...changes,
  };
}

// What a row is, for reading a timeline as a list.
function label(item: TimelineItem): string {
  return item.type === "activity" ? item.entry.id : item.message.key;
}

describe("partyTimeline", () => {
  it("puts the log between the messages, in time order", () => {
    const items = partyTimeline(
      [
        message({ key: "m10", sentAt: 10 }),
        message({ key: "m30", sentAt: 30 }),
        // Still sending, so it isn't placed by its time: the end is its place.
        message({ key: "sending", sentAt: 5, status: "sending" }),
      ],
      [
        partyActivityEntry({ id: "a5", at: 5 }),
        partyActivityEntry({ id: "a20", at: 20 }),
        partyActivityEntry({ id: "a40", at: 40 }),
      ],
    );

    expect(items.map(label)).toEqual(["a5", "m10", "a20", "m30", "a40", "sending"]);
  });

  it("keeps the messages as they are when nothing has happened", () => {
    const items = partyTimeline(
      [message({ key: "m1", sentAt: 10 }), message({ key: "m2", sentAt: 20 })],
      [],
    );

    expect(items.map(label)).toEqual(["m1", "m2"]);
    expect(items.every((item) => item.type === "message")).toBe(true);
  });

  it("shows the log alone when nothing has been said", () => {
    const items = partyTimeline(
      [],
      [partyActivityEntry({ id: "a1", at: 10 }), partyActivityEntry({ id: "a2", at: 20 })],
    );

    expect(items.map(label)).toEqual(["a1", "a2"]);
    expect(items.every((item) => item.type === "activity")).toBe(true);
  });

  it("keeps a message that failed at the end too, after the log", () => {
    const items = partyTimeline(
      [
        message({ key: "m10", sentAt: 10 }),
        message({ key: "failed", sentAt: 1, status: "failed" }),
      ],
      [partyActivityEntry({ id: "a20", at: 20 })],
    );

    expect(items.map(label)).toEqual(["m10", "a20", "failed"]);
  });
});

describe("activityText", () => {
  it("says what happened, in a line", () => {
    const lines: [string, string][] = [
      ["paused", "Ana paused at 14:23"],
      ["resumed", "Ana resumed at 14:23"],
      ["seeked", "Ana skipped to 14:23"],
      ["speed", "Ana changed the speed to 1.5×"],
      ["joined", "Ana joined"],
      ["left", "Ana left"],
      ["media", "Ana started Severance"],
    ];

    for (const [kind, line] of lines) {
      const entry = partyActivityEntry({
        kind,
        rate: 1.5,
        title: kind === "media" ? "Severance" : "",
      });
      expect(activityText(entry)).toBe(line);
    }
  });

  it("reads 14 minutes 23 seconds as the chat's duration does", () => {
    expect(duration(863000)).toBe("14:23");
    expect(activityText(partyActivityEntry())).toBe(`Ana paused at ${duration(863000)}`);
  });

  it("says You for what this device did", () => {
    expect(activityText(partyActivityEntry({ mine: true, name: "Kevin" }))).toBe(
      "You paused at 14:23",
    );
    const skip = partyActivityEntry({ mine: true, kind: "seeked", positionMs: 1140000 });
    expect(activityText(skip)).toBe("You skipped to 19:00");
  });

  it("reads a name that didn't come through as Someone", () => {
    expect(activityText(partyActivityEntry({ name: "", kind: "joined" }))).toBe("Someone joined");
  });

  it("says something new when the party moved on without a title", () => {
    expect(activityText(partyActivityEntry({ kind: "media", title: "" }))).toBe(
      "Ana started something new",
    );
  });

  it("has a line for a kind it doesn't know", () => {
    expect(activityText(partyActivityEntry({ kind: "rewound" }))).toBe("Ana did something");
  });
});
