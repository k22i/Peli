import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { SeekBar } from "./seek-bar";

function renderBar(loop?: { a?: number; b?: number }) {
  return render(
    <SeekBar
      position={10}
      duration={100}
      buffered={0}
      segments={[]}
      {...(loop && { loop })}
      playing={false}
      onScrub={vi.fn<(position: number) => void>()}
      onSeek={vi.fn<(position: number) => void>()}
      onDraggingChange={vi.fn<(dragging: boolean) => void>()}
    />,
  );
}

describe("SeekBar's A–B loop", () => {
  it("marks nothing without a loop", () => {
    renderBar();
    expect(screen.queryByTestId("loop-a")).toBeNull();
    expect(screen.queryByTestId("loop-span")).toBeNull();
  });

  it("marks A alone, then both ends and the span between", () => {
    const { rerender } = renderBar({ a: 20 });
    expect(screen.getByTestId("loop-a")).toHaveStyle({ left: "20%" });
    expect(screen.queryByTestId("loop-b")).toBeNull();
    expect(screen.queryByTestId("loop-span")).toBeNull();
    rerender(
      <SeekBar
        position={10}
        duration={100}
        buffered={0}
        segments={[]}
        loop={{ a: 20, b: 45 }}
        playing={false}
        onScrub={vi.fn<(position: number) => void>()}
        onSeek={vi.fn<(position: number) => void>()}
        onDraggingChange={vi.fn<(dragging: boolean) => void>()}
      />,
    );
    expect(screen.getByTestId("loop-b")).toHaveStyle({ left: "45%" });
    expect(screen.getByTestId("loop-span")).toHaveStyle({ left: "20%" });
  });
});
