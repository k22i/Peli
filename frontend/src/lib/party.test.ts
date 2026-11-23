import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Reaction } from "@bindings/party";
import type { Watching } from "@bindings/playback";
import type * as Runtime from "@wailsio/runtime";

import {
  duration,
  formatCode,
  inviteText,
  matchesPartySource,
  mediaLabel,
  memberStatus,
  noticeText,
  normalizeCode,
  partyMedia,
  partyWatches,
  reactionEvent,
  reactionName,
  REACTIONS,
  usePartyReactions,
  useSendReaction,
} from "@/lib/party";
import { partyMember as member, partyState } from "@/test/fixtures";

// A party's events, by hand: a Set of listeners per event, so a test sends one
// and an unmount's unsubscribe can be seen.
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { data: unknown }) => void>>(),
  sendReaction: vi.fn<(emoji: string) => Promise<void>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        const callbacks: Set<(event: { data: unknown }) => void> =
          mocks.listeners.get(name) ?? new Set();
        callbacks.add(callback);
        mocks.listeners.set(name, callbacks);
        return () => void callbacks.delete(callback);
      },
    },
  };
});

// The party service, by hand: what the hooks below call, plus the two queries
// lib/party builds as it loads.
vi.mock("@bindings/party", () => ({
  Service: {
    State: vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ unavailable: "", busy: false, party: null }),
    ),
    Chat: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ messages: [], unread: 0 })),
    Activity: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ entries: [] })),
    SendReaction: mocks.sendReaction,
  },
}));

// Ana's fire, or another member's emoji.
function reaction(changes: Partial<Reaction> = {}): Reaction {
  return { emoji: "🔥", memberId: "ana", name: "Ana", mine: false, at: 1_000, ...changes };
}

// A refusal as party.MarshalError sends it: the code in the call's cause.
function refusal(code: string): Error {
  const error = new Error(`party: ${code}`);
  Object.defineProperty(error, "cause", { value: { code } });
  return error;
}

function emit(name: string, data: unknown) {
  act(() => {
    for (const callback of mocks.listeners.get(name) ?? []) callback({ data });
  });
}

const listeners = (name: string) => mocks.listeners.get(name)?.size ?? 0;

beforeEach(() => {
  mocks.listeners.clear();
  mocks.sendReaction.mockReset();
  mocks.sendReaction.mockResolvedValue(undefined);
});

const source = {
  infoHash: "",
  fileIdx: null,
  filename: "",
  videoSize: 0,
  bingeGroup: "",
  addonId: "",
  name: "",
};

describe("party codes", () => {
  it("keeps the code's letters, upper case, and shows it in two halves", () => {
    expect(normalizeCode(" abc-d e f ")).toBe("ABCDEF");
    expect(normalizeCode("10OI")).toBe("");
    expect(formatCode("abcdef")).toBe("ABC DEF");
    expect(formatCode("abc")).toBe("ABC");
  });

  it("invites with the code and Nuvio's link", () => {
    expect(inviteText("ABCDEF")).toBe(
      "Join my watch party with code ABC DEF\nhttps://nuvio.tv/party/ABCDEF",
    );
  });
});

describe("matchesPartySource", () => {
  it("matches the same torrent, and file when both say", () => {
    const party = { ...source, infoHash: "ABC", fileIdx: 2 };
    expect(matchesPartySource({ infoHash: "abc", fileIdx: 2 }, party)).toBe(true);
    expect(matchesPartySource({ infoHash: "abc" }, party)).toBe(true);
    expect(matchesPartySource({ infoHash: "abc", fileIdx: 3 }, party)).toBe(false);
    expect(matchesPartySource({ infoHash: "def", fileIdx: 2 }, party)).toBe(false);
  });

  it("else the same file name", () => {
    const party = { ...source, filename: "Show.S01E03.1080p.mkv" };
    expect(
      matchesPartySource(
        { url: "https://x", behaviorHints: { filename: "show.s01e03.1080p.mkv" } },
        party,
      ),
    ).toBe(true);
    expect(
      matchesPartySource({ url: "https://x", behaviorHints: { filename: "other.mkv" } }, party),
    ).toBe(false);
  });

  it("matches nothing without a source", () => {
    expect(matchesPartySource({ infoHash: "abc" }, null)).toBe(false);
    expect(matchesPartySource({ name: "1080p" }, { ...source, name: "1080p" })).toBe(false);
  });
});

describe("partyMedia", () => {
  it("names an episode as Nuvio's apps do, with the stream that plays", () => {
    const watching: Watching = {
      profileId: 1,
      contentId: "tt0903747",
      contentType: "series",
      videoId: "tt0903747:1:3",
      season: 1,
      episode: 3,
      title: "…And the Bag's in the River",
      name: "Breaking Bad",
    };
    const media = partyMedia(
      watching,
      { title: "Breaking Bad", episode: "S1 E3" },
      { id: "tt0903747", type: "series", name: "Breaking Bad", poster: "https://p.jpg" },
      {
        infoHash: "ABC",
        fileIdx: 4,
        name: "Torrentio\n1080p",
        behaviorHints: { filename: "bb.mkv", videoSize: 123 },
      },
    );
    expect(media).toMatchObject({
      type: "series",
      id: "tt0903747",
      videoId: "tt0903747:1:3",
      season: 1,
      episode: 3,
      title: "Breaking Bad",
      episodeTitle: "…And the Bag's in the River",
      poster: "https://p.jpg",
      source: {
        infoHash: "abc",
        fileIdx: 4,
        filename: "bb.mkv",
        videoSize: 123,
        name: "Torrentio\n1080p",
      },
    });
    expect(mediaLabel(media)).toBe("Breaking Bad · S1 E3");
  });

  it("gives a film no video id of its own", () => {
    const media = partyMedia(
      { profileId: 1, contentId: "tt0111161", contentType: "movie", videoId: "tt0111161" },
      { title: "The Shawshank Redemption" },
      undefined,
      undefined,
    );
    expect(media).toMatchObject({ videoId: "", season: null, episode: null, source: null });
    expect(mediaLabel(media)).toBe("The Shawshank Redemption");
  });
});

describe("partyWatches", () => {
  const party = partyState({}, { type: "series", id: "tt1", videoId: "tt1:1:2" }).party;
  it("is the same title and episode", () => {
    expect(partyWatches(party, "series", "tt1", "tt1:1:2")).toBe(true);
    expect(partyWatches(party, "series", "tt1", "tt1:1:3")).toBe(false);
    expect(partyWatches(undefined, "series", "tt1", "tt1:1:2")).toBe(false);
  });
  it("is the film's own id for a film", () => {
    const film = partyState({}, { type: "movie", id: "tt9", videoId: "" }).party;
    expect(partyWatches(film, "movie", "tt9", "tt9")).toBe(true);
  });
});

describe("what the party says", () => {
  it("names each member's status", () => {
    expect(memberStatus(member({ status: "ready" }))).toBe("Watching");
    expect(memberStatus(member({ status: "browsing" }))).toBe("Choosing a source");
    expect(memberStatus(member({ status: "behind", behindMs: 65_000 }))).toBe("1:05 behind");
    expect(memberStatus(member({ status: "ready", watchingElse: true }))).toBe(
      "Watching something else",
    );
    expect(memberStatus(member({ status: "offline", watchingElse: true }))).toBe("Offline");
  });
  it("says what someone did", () => {
    const base = { name: "Ana", action: "", positionMs: 0, rate: 1, media: null, hostOnly: false };
    expect(noticeText({ ...base, kind: "action", action: "seeked", positionMs: 3_723_000 })).toBe(
      "Ana skipped to 1:02:03",
    );
    expect(noticeText({ ...base, kind: "action", action: "speed", rate: 1.5 })).toBe(
      "Ana changed the speed to 1.5×",
    );
    expect(noticeText({ ...base, kind: "control", hostOnly: true })).toBe(
      "Only the host can control playback now",
    );
    expect(duration(59_400)).toBe("0:59");
  });
});

describe("REACTIONS", () => {
  it("is the eight emoji in the order the bar shows them", () => {
    expect(REACTIONS).toEqual(["😂", "❤️", "🔥", "😮", "😢", "👏", "🎉", "🍿"]);
  });

  it("names every emoji for a screen reader", () => {
    expect(REACTIONS.map((emoji) => reactionName[emoji])).toEqual([
      "laugh",
      "love",
      "fire",
      "wow",
      "sad",
      "applause",
      "party",
      "popcorn",
    ]);
  });

  it("listens on the event Go sends", () => {
    expect(reactionEvent).toBe("party:reaction");
  });
});

describe("useSendReaction", () => {
  it("sends the emoji through the party service", async () => {
    const { result } = renderHook(() => useSendReaction());

    await act(async () => result.current("🔥"));

    expect(mocks.sendReaction).toHaveBeenCalledWith("🔥");
  });

  it("says nothing when the party ended under it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendReaction.mockRejectedValue(refusal("not_in_party"));
    const { result } = renderHook(() => useSendReaction());

    await act(async () => result.current("🔥"));

    expect(mocks.sendReaction).toHaveBeenCalledWith("🔥");
    expect(logged).not.toHaveBeenCalled();
  });

  it("logs anything else Go refuses", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendReaction.mockRejectedValue(refusal("invalid"));
    const { result } = renderHook(() => useSendReaction());

    await act(async () => result.current("🦄"));

    expect(logged).toHaveBeenCalledWith("Couldn’t send a reaction", expect.anything());
  });
});

describe("usePartyReactions", () => {
  it("hands each reaction to the callback", () => {
    const onReaction = vi.fn<(reaction: Reaction) => void>();
    renderHook(() => usePartyReactions(onReaction));
    const fire = reaction();

    emit(reactionEvent, fire);

    expect(onReaction).toHaveBeenCalledExactlyOnceWith(fire);
  });

  it("calls the latest callback without subscribing again", () => {
    const first = vi.fn<(reaction: Reaction) => void>();
    const later = vi.fn<(reaction: Reaction) => void>();
    const { rerender } = renderHook(({ onReaction }) => usePartyReactions(onReaction), {
      initialProps: { onReaction: first },
    });

    rerender({ onReaction: later });
    emit(reactionEvent, reaction());

    expect(first).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
    expect(listeners(reactionEvent)).toBe(1);
  });

  it("stops listening when it unmounts", () => {
    const onReaction = vi.fn<(reaction: Reaction) => void>();
    const { unmount } = renderHook(() => usePartyReactions(onReaction));
    expect(listeners(reactionEvent)).toBe(1);

    unmount();

    expect(listeners(reactionEvent)).toBe(0);
    emit(reactionEvent, reaction());
    expect(onReaction).not.toHaveBeenCalled();
  });
});
