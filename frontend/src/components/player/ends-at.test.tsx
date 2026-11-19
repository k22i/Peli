import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PlayerEndsAt } from "@/components/player/ends-at";
import { clockTime } from "@/lib/ends-at";

const at = (hours: number, minutes: number) =>
  `Ends at ${clockTime(new Date(2026, 10, 19, hours, minutes).getTime())}`;

describe("PlayerEndsAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 19, 21, 30, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says when the time remaining runs out", () => {
    render(<PlayerEndsAt remaining={72 * 60} speed={1} />);
    expect(screen.getByTestId("ends-at")).toHaveTextContent(at(22, 42));
  });

  it("counts the speed", () => {
    render(<PlayerEndsAt remaining={60 * 60} speed={2} />);
    expect(screen.getByTestId("ends-at")).toHaveTextContent(at(22, 0));
  });

  // Paused, the time remaining stays put but the clock doesn't.
  it("moves on while paused", () => {
    render(<PlayerEndsAt remaining={72 * 60} speed={1} />);
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(screen.getByTestId("ends-at")).toHaveTextContent(at(22, 45));
  });

  it("follows a seek", () => {
    const { rerender } = render(<PlayerEndsAt remaining={72 * 60} speed={1} />);
    rerender(<PlayerEndsAt remaining={12 * 60} speed={1} />);
    expect(screen.getByTestId("ends-at")).toHaveTextContent(at(21, 42));
  });

  it("shows nothing once nothing is left", () => {
    render(<PlayerEndsAt remaining={0} speed={1} />);
    expect(screen.queryByTestId("ends-at")).not.toBeInTheDocument();
  });
});
