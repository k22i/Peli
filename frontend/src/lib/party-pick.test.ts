import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Source as PartySource } from "@bindings/party";
import type { Source } from "@bindings/streams";
import type { Stream } from "@/lib/addon-protocol";
import {
  closestToHost,
  isPartyGuest,
  orderForParty,
  partyPlan,
  usePartyAutoPick,
  waitAfterFirst,
} from "@/lib/party-pick";
import { Party, type PartyInfo, type SharedStream } from "@/lib/party";
import { candidate, titleContext, type Candidate } from "@/lib/ranking";
import type { Attempt } from "@/lib/resolve";
import { partyMember, partyState } from "@/test/fixtures";

const mocks = vi.hoisted(() => ({
  choices: vi.fn<() => unknown>(),
  resolvePick: vi.fn<(candidate: Candidate, options: { signal: AbortSignal }) => Promise<unknown>>(),
  load: vi.fn<(source: Source, options: { start: number }) => Promise<void>>(),
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
  setChosen: vi.fn<() => Promise<void>>(),
}));

// The picker's data hook is the page's; the chooser only reads what it
// returns.
vi.mock("@/components/streams/streams-page", () => ({
  useStreamChoices: () => mocks.choices(),
}));

vi.mock("@/lib/resolve", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolvePick: mocks.resolvePick,
}));

vi.mock("@bindings/player", () => ({ Service: { Load: mocks.load } }));
vi.mock("@bindings/streams", () => ({ Service: { Resolve: vi.fn<() => void>() } }));
vi.mock("@bindings/torrent", () => ({ Service: { Open: vi.fn<() => void>() } }));
vi.mock("@bindings/store", () => ({
  Service: { SetChosenSource: mocks.setChosen, ChosenSource: () => Promise.resolve(null) },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => mocks.navigate,
}));

const ctx = titleContext("movie", "tt0111161", undefined, "The Shawshank Redemption");
const addon = "https://addon.example/manifest.json";
const GB = 1_000_000_000;

// A direct stream named like a release, with its size as the addon says.
const stream = (file: string, size = 8 * GB): Stream => ({
  name: "Addon",
  url: `https://cdn.example/${file}`,
  behaviorHints: { filename: file, videoSize: size },
});

const pick = (file: string, size = 8 * GB): Candidate =>
  candidate(addon, stream(file, size), 0, ctx);

const hostSource = (file: string, size = 8 * GB): PartySource => ({
  infoHash: "",
  fileIdx: null,
  filename: file,
  videoSize: size,
  bingeGroup: "",
  addonId: "",
  name: "",
});

const shared = (file = "Shared.2020.1080p.mkv"): SharedStream => ({
  mediaKey: "",
  url: `https://shared.example/${file}`,
  headers: { Authorization: "x" },
  responseHeaders: {},
  name: "Shared",
  description: "",
  addonName: "Ana’s addon",
  addonId: "",
  addonLogo: "",
  filename: file,
  videoSize: 4 * GB,
  bingeGroup: "",
  sharedBy: "Ana",
});

function party(source: PartySource | null, rest: Partial<PartyInfo> = {}): PartyInfo {
  return partyState(rest, { source }).party!;
}

const hostFile = "Movie.2020.1080p.WEB-DL.x264-AAA.mkv";

describe("orderForParty", () => {
  const a720 = pick("Movie.2020.720p.WEB-DL.x264-AAA.mkv");
  const a2160 = pick("Movie.2020.2160p.WEB-DL.x265-AAA.mkv");
  const exact = pick(hostFile);

  it("puts the guest’s copy of the host’s stream first, and says it’s exact", () => {
    const result = orderForParty([a720, exact, a2160], party(hostSource(hostFile)));
    expect(result.ordered[0]).toBe(exact);
    expect(result.reason).toBe("match");
    expect(result.exact).toBe(true);
  });

  it("puts the shared link after the match and before the rest", () => {
    const plan = partyPlan([a720, exact], party(hostSource(hostFile), { shared: shared() }));
    expect(plan.map((step) => (step.kind === "shared" ? "shared" : step.reason))).toEqual([
      "match",
      "shared",
      expect.stringMatching(/closest|top/),
    ]);
  });

  it("leads with the shared link when nothing matches", () => {
    const result = orderForParty([a720, a2160], party(hostSource(hostFile), { shared: shared() }));
    expect(result.reason).toBe("shared");
    expect(result.exact).toBe(false);
    // The candidates behind it are still the closest first.
    expect(result.ordered[0]).toBe(a720);
  });

  it("takes the same resolution before anything else", () => {
    const same = pick("Movie.2020.1080p.HDTV.x264-ZZZ.mkv", 1 * GB);
    const result = orderForParty([a2160, a720, same], party(hostSource(hostFile)));
    expect(result.ordered).toEqual([same, a2160, a720]);
    expect(result.reason).toBe("closest");
    expect(result.exact).toBe(false);
  });

  it("then the same source or release group", () => {
    const other = pick("Movie.2020.1080p.BluRay.x264-ZZZ.mkv");
    const alike = pick("Movie.2020.1080p.WEB-DL.x264-BBB.mkv");
    const group = pick("Movie.2020.1080p.HDTV.x264-AAA.mkv");
    expect(group.parsed.group?.toLowerCase()).toBe("aaa");
    expect(alike.parsed.source).toBe("web-dl");
    const result = orderForParty([other, alike, group], party(hostSource(hostFile)));
    // None is exactly it; the ones sharing source or group come first, the
    // one sharing neither last.
    expect(result.ordered[2]).toBe(other);
  });

  it("then the nearest size", () => {
    const far = pick("Movie.2020.1080p.mkv", 20 * GB);
    const near = pick("Movie.A.2020.1080p.mkv", 9 * GB);
    const { ordered } = closestToHost([far, near], hostSource("Other.1080p.mkv", 8 * GB));
    expect(ordered).toEqual([near, far]);
  });

  it("keeps the ranking order among equals", () => {
    const first = pick("One.2020.1080p.mkv", 8 * GB);
    const second = pick("Two.2020.1080p.mkv", 8 * GB);
    expect(closestToHost([first, second], hostSource("Host.1080p.mkv")).ordered).toEqual([
      first,
      second,
    ]);
  });

  it("falls back to the guest’s top pick when nothing is alike, or the host’s stream is unknown", () => {
    const top = pick("Movie.2020.2160p.mkv");
    const next = pick("Movie.2020.720p.mkv");
    const unlike = orderForParty([top, next], party(hostSource("Movie.2020.480p.mkv")));
    expect(unlike.ordered).toEqual([top, next]);
    expect(unlike.reason).toBe("top");
    const unknown = orderForParty([top, next], party(null));
    expect(unknown.ordered).toEqual([top, next]);
    expect(unknown.reason).toBe("top");
    expect(unknown.exact).toBe(false);
  });
});

describe("isPartyGuest", () => {
  const guest = party(null);

  it("is false without a party and for the host", () => {
    expect(isPartyGuest(null)).toBe(false);
    expect(isPartyGuest(undefined)).toBe(false);
    expect(isPartyGuest({ ...guest, isHost: true })).toBe(false);
  });

  it("is true for a member, whatever they play, when no media is given", () => {
    expect(isPartyGuest(guest)).toBe(true);
  });

  it("is true only for the party’s own media", () => {
    expect(isPartyGuest(guest, guest.media)).toBe(true);
    expect(isPartyGuest(guest, { ...guest.media, type: "MOVIE" })).toBe(true);
    expect(isPartyGuest(guest, { ...guest.media, id: "tt0000001" })).toBe(false);
  });

  it("compares the video too, an empty one standing for the id", () => {
    const episode = party(null, {});
    episode.media = { ...episode.media, id: "tt1", videoId: "tt1:1:2" };
    expect(isPartyGuest(episode, { ...episode.media })).toBe(true);
    expect(isPartyGuest(episode, { ...episode.media, videoId: "tt1:1:3" })).toBe(false);
    expect(isPartyGuest(episode, { ...episode.media, videoId: "" })).toBe(false);
    expect(isPartyGuest(guest, { ...guest.media, videoId: guest.media.id })).toBe(true);
  });
});

type Status = "pending" | "success" | "error";

// What useStreamChoices returns, as far as the chooser reads it.
function choose(candidates: Candidate[], statuses: Status[], answered = false) {
  mocks.choices.mockReturnValue({
    ranked: { top: candidates[0] ?? null, groups: [{ items: candidates }], total: candidates.length },
    answered,
    loading: false,
    sources: statuses.map((status, index) => ({ key: `s${index}`, status })),
    names: new Map([[addon, "Addon"]]),
    meta: undefined,
    settings: undefined,
    refresh: () => Promise.resolve([]),
  });
}

const resolved = (c: Candidate): { source: Source; attempt: Attempt } => ({
  source: {
    url: `${c.stream.url}#cdn`,
    origin: c.stream.url ?? "",
    headers: {},
    userAgent: "Peli/test",
    contentType: "video/x-matroska",
    size: 1,
  },
  attempt: { source: c.source, stream: c.stream },
});

type Props = { party: PartyInfo | null } & Partial<Parameters<typeof usePartyAutoPick>[0]>;

function render(initial: Props) {
  return renderHook(
    (props: Props) =>
      usePartyAutoPick({
        profileId: 1,
        type: "movie",
        id: "tt0111161",
        video: "tt0111161",
        title: "The Shawshank Redemption",
        enabled: true,
        ...props,
      }),
    { initialProps: initial },
  );
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.resolvePick.mockImplementation((c) => Promise.resolve(resolved(c)));
  mocks.load.mockResolvedValue();
  mocks.navigate.mockResolvedValue();
  vi.mocked(Party.StartAt).mockResolvedValue(-1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("when the chooser starts", () => {
  const match = pick(hostFile);
  const other = pick("Movie.2020.720p.WEB-DL.x264-BBB.mkv");

  it("picks at once when one of the guest’s streams is the host’s, before everyone answered", async () => {
    choose([other, match], ["success", "pending"]);
    const { result } = render({ party: party(hostSource(hostFile)) });
    await flush();
    expect(mocks.resolvePick).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePick.mock.calls[0]![0]).toBe(match);
    expect(result.current.status).toBe("done");
    expect(result.current.reason).toBe("match");
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it("without a match waits for every addon, or ten seconds after the first answer", async () => {
    choose([other], ["pending", "pending"]);
    const { result, rerender } = render({ party: party(hostSource(hostFile)) });
    // Nobody has answered: the ten seconds haven’t started.
    await advance(waitAfterFirst * 3);
    expect(mocks.resolvePick).not.toHaveBeenCalled();
    expect(result.current.status).toBe("searching");

    choose([other], ["success", "pending"]);
    rerender({ party: party(hostSource(hostFile)) });
    await advance(waitAfterFirst - 1);
    expect(mocks.resolvePick).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.resolvePick).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePick.mock.calls[0]![0]).toBe(other);
    expect(result.current.status).toBe("done");
  });

  it("without a match picks as soon as every addon has answered", async () => {
    choose([other], ["success", "error"]);
    const { result } = render({ party: party(hostSource(hostFile)) });
    await flush();
    expect(mocks.resolvePick).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("done");
  });

  it("does nothing while disabled, for the host, or for something else", async () => {
    choose([match], ["success"], true);
    render({ party: party(hostSource(hostFile)), enabled: false });
    render({ party: { ...party(hostSource(hostFile)), isHost: true } });
    render({ party: party(hostSource(hostFile)), id: "tt0000001", video: "tt0000001" });
    await advance(waitAfterFirst * 2);
    expect(mocks.resolvePick).not.toHaveBeenCalled();
  });

  it("names the host, or says “the host”", () => {
    choose([], ["pending"]);
    const named = render({
      party: party(null, { members: [partyMember({ id: "x", name: "Ana", host: true })] }),
    });
    expect(named.result.current.hostName).toBe("Ana");
    const nobody = render({ party: party(null, { members: [] }) });
    expect(nobody.result.current.hostName).toBe("the host");
  });
});

describe("resolving", () => {
  const first = pick("Movie.2020.1080p.WEB-DL.x264-AAA.mkv");
  const second = pick("Movie.2020.1080p.WEB-DL.x264-BBB.mkv", 7 * GB);
  const state = () => party(hostSource("Movie.2020.1080p.WEB-DL.x264-CCC.mkv"));

  it("tries the next candidate when one fails, in the chooser’s order", async () => {
    choose([first, second], ["success"], true);
    mocks.resolvePick.mockImplementation((c) =>
      c === first ? Promise.reject(new Error("failed")) : Promise.resolve(resolved(c)),
    );
    const { result } = render({ party: state() });
    await flush();
    expect(mocks.resolvePick.mock.calls.map(([c]) => c)).toEqual([first, second]);
    expect(result.current.status).toBe("done");
    expect(result.current.picked?.candidate).toBe(second);
  });

  it("fails when every candidate does, and retry runs the chooser again", async () => {
    choose([first, second], ["success"], true);
    mocks.resolvePick.mockRejectedValue(new Error("failed"));
    const { result } = render({ party: state() });
    await flush();
    expect(result.current.status).toBe("failed");
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.resolvePick.mockImplementation((c) => Promise.resolve(resolved(c)));
    act(() => result.current.retry());
    await flush();
    expect(result.current.status).toBe("done");
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("plays the shared link when no copy of the host’s stream is there", async () => {
    choose([], ["success"], true);
    vi.mocked(Party.StartAt).mockResolvedValue(42);
    const { result } = render({ party: party(hostSource(hostFile), { shared: shared() }) });
    await flush();
    expect(result.current.status).toBe("done");
    expect(result.current.reason).toBe("shared");
    expect(mocks.resolvePick).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith(
      expect.objectContaining({ url: shared().url }),
      expect.objectContaining({ start: 42 }),
    );
  });

  it("starts where the party is, and opens /player with the stream that played", async () => {
    choose([first], ["success"], true);
    vi.mocked(Party.StartAt).mockResolvedValue(95.5);
    render({ party: state() });
    await flush();
    expect(mocks.load).toHaveBeenCalledWith(
      expect.objectContaining({ origin: first.stream.url }),
      expect.objectContaining({ start: 95.5 }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/player" }));
  });

  it("fails when the player can’t load the file", async () => {
    choose([first], ["success"], true);
    mocks.load.mockRejectedValue(new Error("no"));
    const { result } = render({ party: state() });
    await flush();
    expect(result.current.status).toBe("failed");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("with open: false returns the pick and neither loads nor navigates", async () => {
    choose([first], ["success"], true);
    const onPicked = vi.fn<(picked: unknown) => void>();
    const { result } = render({ party: state(), open: false, onPicked });
    await flush();
    expect(result.current.status).toBe("done");
    expect(result.current.picked).toMatchObject({ candidate: first, start: 0 });
    expect(result.current.picked?.source?.origin).toBe(first.stream.url);
    expect(onPicked).toHaveBeenCalledWith(result.current.picked);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("resolves nothing when the pick is what plays already", async () => {
    choose([first, second], ["success"], true);
    const onPicked = vi.fn<(picked: unknown) => void>();
    const { result } = render({
      party: party(hostSource("Movie.2020.1080p.WEB-DL.x264-AAA.mkv")),
      current: { ...first.stream },
      open: false,
      onPicked,
    });
    await flush();
    expect(result.current.status).toBe("done");
    expect(result.current.picked?.same).toBe(true);
    expect(mocks.resolvePick).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("switches to the pick when it isn’t what plays", async () => {
    choose([first, second], ["success"], true);
    const { result } = render({
      party: party(hostSource("Movie.2020.1080p.WEB-DL.x264-AAA.mkv")),
      current: second.stream,
      open: false,
    });
    await flush();
    expect(result.current.picked?.same).toBeFalsy();
    expect(result.current.picked?.candidate).toBe(first);
  });

  it("never remembers the pick as the show’s source", async () => {
    choose([first], ["success"], true);
    render({ party: state() });
    await flush();
    expect(mocks.setChosen).not.toHaveBeenCalled();
  });
});

describe("restarting", () => {
  const first = pick(hostFile);

  it("aborts what was resolving and starts again when the host’s stream changes", async () => {
    choose([first], ["success"], true);
    const signals: AbortSignal[] = [];
    mocks.resolvePick.mockImplementation((_, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { rerender } = render({ party: party(hostSource(hostFile)) });
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    rerender({ party: party(hostSource("Movie.2020.720p.mkv")) });
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);
  });

  it("aborts on unmount", async () => {
    choose([first], ["success"], true);
    const signals: AbortSignal[] = [];
    mocks.resolvePick.mockImplementation((_, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { unmount } = render({ party: party(hostSource(hostFile)) });
    await flush();
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("starts again when it is enabled again", async () => {
    choose([first], ["success"], true);
    const { rerender } = render({ party: party(hostSource(hostFile)) });
    await flush();
    expect(mocks.resolvePick).toHaveBeenCalledTimes(1);
    rerender({ party: party(hostSource(hostFile)), enabled: false });
    await flush();
    rerender({ party: party(hostSource(hostFile)), enabled: true });
    await flush();
    expect(mocks.resolvePick).toHaveBeenCalledTimes(2);
  });
});
