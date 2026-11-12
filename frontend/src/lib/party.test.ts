import { describe, expect, it } from "vite-plus/test";

import type { Watching } from "@bindings/playback";
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
} from "@/lib/party";
import { partyMember as member, partyState } from "@/test/fixtures";

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
