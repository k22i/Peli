import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Track } from "@bindings/player";
import {
  formatTime,
  latestOnly,
  loadOptions,
  nextTrackId,
  subtitleDelayText,
  trackLabel,
  useAhead,
  useIdle,
} from "@/lib/player";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatTime", () => {
  it("shows minutes and seconds, and hours from an hour on", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(-4)).toBe("0:00");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

describe("latestOnly", () => {
  it("sends one at a time, then only the newest that came meanwhile", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn<(value: number) => Promise<void>>(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const latest = latestOnly(send);
    latest(1);
    latest(2);
    latest(3);
    expect(send.mock.calls).toEqual([[1]]);

    await act(async () => pending.shift()?.());
    expect(send.mock.calls).toEqual([[1], [3]]);
    await act(async () => pending.shift()?.());
    latest(4);
    expect(send.mock.calls).toEqual([[1], [3], [4]]);
  });

  it("carries on after a failure", async () => {
    const send = vi.fn<(value: number) => Promise<void>>((value) =>
      value === 1 ? Promise.reject(new Error("no")) : Promise.resolve(),
    );
    const latest = latestOnly(send);
    latest(1);
    latest(2);
    await act(async () => {});
    expect(send.mock.calls).toEqual([[1], [2]]);
  });
});

const same = (a: boolean, b: boolean) => a === b;

describe("useAhead", () => {
  it("shows what was set until the player's value catches up", () => {
    const { result, rerender } = renderHook(({ actual }) => useAhead(actual, same), {
      initialProps: { actual: false },
    });
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    rerender({ actual: true });
    expect(result.current[0]).toBe(true);
    // Caught up, so the player's value rules again.
    rerender({ actual: false });
    expect(result.current[0]).toBe(false);
  });

  it("gives up after a few seconds", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAhead<boolean>(false, same));
    act(() => result.current[1](true));
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current[0]).toBe(false);
  });
});

describe("useIdle", () => {
  it("goes idle when nothing happens, and wakes", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdle(3000));
    expect(result.current[0]).toBe(false);
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current[0]).toBe(true);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    act(() => void vi.advanceTimersByTime(2000));
    act(() => result.current[1]());
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current[0]).toBe(false);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBe(true);
  });
});

const track = (fields: Partial<Track> & Pick<Track, "id" | "type">): Track => ({
  title: "",
  lang: "",
  codec: "",
  default: false,
  selected: false,
  external: false,
  forced: false,
  hearingImpaired: false,
  ...fields,
});

describe("loadOptions", () => {
  const settings = {
    audioLanguage: "ja",
    subtitleLanguage: "en",
    subtitleSize: "large",
    captions: "system",
  };
  const profile = { ...settings, skipIntros: false };

  it("takes the profile's languages, captions and size", () => {
    expect(loadOptions(5, profile)).toEqual({ start: 5, ...settings });
    expect(loadOptions(0, undefined)).toEqual({
      start: 0,
      audioLanguage: "",
      subtitleLanguage: "",
      captions: "system",
      subtitleSize: "",
    });
  });

  it("names what it plays, for its progress (#64)", () => {
    const watching = { profileId: 1, contentId: "tt1", contentType: "movie", videoId: "tt1" };
    expect(loadOptions(5, profile, [], watching)).toEqual({ start: 5, ...settings, watching });
  });

  it("keeps the tracks the file was playing", () => {
    const playing = [
      track({ id: 1, type: "audio", lang: "eng", selected: true }),
      track({ id: 2, type: "sub", lang: "spa", selected: true }),
    ];
    expect(loadOptions(5, profile, playing)).toMatchObject({
      audioLanguage: "eng",
      subtitleLanguage: "spa",
      captions: "on",
      subtitleSize: "large",
    });
    // Forced subtitles only, or none: captions were off.
    playing[1] = { ...playing[1]!, forced: true };
    expect(loadOptions(5, profile, playing)).toMatchObject({ captions: "off" });
    expect(loadOptions(5, profile, playing.slice(0, 1))).toMatchObject({
      subtitleLanguage: "",
      captions: "off",
    });
    // A tag Go wouldn't take is the file's default.
    expect(
      loadOptions(5, profile, [track({ id: 1, type: "audio", lang: "en-US", selected: true })]),
    ).toMatchObject({ audioLanguage: "" });
  });
});

describe("trackLabel", () => {
  it("names a track by its language, and tells it apart by the rest", () => {
    expect(
      trackLabel(track({ id: 1, type: "audio", lang: "jpn", codec: "eac3", channels: 6 })),
    ).toEqual({ name: "Japanese", detail: "EAC3 · 5.1" });
    expect(
      trackLabel(track({ id: 2, type: "sub", lang: "en", title: "Signs", forced: true })),
    ).toEqual({ name: "English", detail: "Signs · Forced" });
    expect(
      trackLabel(
        track({ id: 3, type: "sub", title: "Director", external: true, hearingImpaired: true }),
      ),
    ).toEqual({ name: "Director", detail: "SDH · External" });
    expect(trackLabel(track({ id: 4, type: "audio", lang: "und", channels: 3 }))).toEqual({
      name: "Track 4",
      detail: "3 ch",
    });
  });
});

describe("subtitleDelayText", () => {
  it("says which way subtitles moved", () => {
    expect(subtitleDelayText(0)).toBe("On time");
    expect(subtitleDelayText(0.30000001)).toBe("0.3 s later");
    expect(subtitleDelayText(-1.2)).toBe("1.2 s earlier");
  });
});

describe("nextTrackId", () => {
  it("goes round the tracks, through off for subtitles", () => {
    expect(nextTrackId([0, 3, 4], 0)).toBe(3);
    expect(nextTrackId([0, 3, 4], 3)).toBe(4);
    expect(nextTrackId([0, 3, 4], 4)).toBe(0);
    expect(nextTrackId([1, 2], 2)).toBe(1);
    // A track that went: the first.
    expect(nextTrackId([1, 2], 7)).toBe(1);
    expect(nextTrackId([], 5)).toBe(5);
  });
});
