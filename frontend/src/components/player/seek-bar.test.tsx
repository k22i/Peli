import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PreviewImage } from "@/lib/previews";
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

// The same bar with the seek previews (lib/previews) wired in, and the times
// it asked Go for. No `preview` stands for previews that are off.
function renderPreviewBar(preview?: (seconds: number) => PreviewImage | undefined) {
  const want = vi.fn<(seconds: number) => void>();
  render(
    <SeekBar
      position={10}
      duration={100}
      buffered={0}
      segments={[]}
      playing={false}
      preview={preview}
      onPreviewWant={want}
      onScrub={vi.fn<(position: number) => void>()}
      onSeek={vi.fn<(position: number) => void>()}
      onDraggingChange={vi.fn<(dragging: boolean) => void>()}
    />,
  );
  return want;
}

// The pointer a quarter of the way along the bar: 25 of 100 seconds.
function hover(bar: HTMLElement) {
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 20 }),
  );
  fireEvent.pointerMove(bar, { clientX: 250 });
}

const exact: PreviewImage = { url: "data:image/jpeg;base64,", w: 320, h: 180, exact: true };

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

describe("SeekBar's previews", () => {
  it("shows the thumbnail for the time under the pointer and asks for it", () => {
    const want = renderPreviewBar(() => exact);
    expect(screen.queryByTestId("seek-thumb")).toBeNull();

    hover(screen.getByTestId("seek-bar"));
    const thumb = screen.getByTestId("seek-thumb");
    const image = thumb.querySelector("img");
    expect(image).toHaveAttribute("src", exact.url);
    expect(image).toHaveAttribute("width", "320");
    expect(image).toHaveAttribute("height", "180");
    expect(thumb).toHaveAttribute("data-exact");
    expect(thumb).toHaveAttribute("data-state", "ready");
    // The bubble holds the thumbnail, so it's padded all round, not just
    // across.
    expect(screen.getByTestId("seek-time")).toHaveClass("p-1.5");
    expect(want).toHaveBeenLastCalledWith(25);
  });

  it("shows only the time without previews", () => {
    renderPreviewBar();
    hover(screen.getByTestId("seek-bar"));
    expect(screen.getByTestId("seek-time")).toHaveTextContent("0:25");
    expect(screen.queryByTestId("seek-thumb")).toBeNull();
  });

  it("dims a neighbouring bucket's thumbnail", () => {
    renderPreviewBar(() => ({ ...exact, exact: false }));
    hover(screen.getByTestId("seek-bar"));
    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb).not.toHaveAttribute("data-exact");
    expect(thumb.querySelector("img")).toHaveClass("opacity-60");
  });

  it("shows a placeholder with a spinner while the first thumbnail loads", () => {
    renderPreviewBar(() => ({ url: undefined, w: 320, h: 180, exact: false, loading: true }));
    hover(screen.getByTestId("seek-bar"));
    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb).toHaveAttribute("data-state", "loading");
    expect(thumb.querySelector("img")).toBeNull();
    expect(thumb.querySelector("svg.animate-spin")).not.toBeNull();
    expect(thumb).not.toHaveTextContent("No preview");
  });

  it("says there's no preview when one can't be made, without a spinner", () => {
    renderPreviewBar(() => ({ url: undefined, w: 320, h: 180, exact: false, failed: true }));
    hover(screen.getByTestId("seek-bar"));
    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb).toHaveAttribute("data-state", "failed");
    expect(thumb).toHaveTextContent("No preview");
    expect(thumb.querySelector("svg.animate-spin")).toBeNull();
  });
});
