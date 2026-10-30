import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatTime, latestOnly, useAhead, useIdle } from "@/lib/player";

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
