import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { Chip, ChipRail } from "@/components/media/chip";
import { ScrollRail } from "@/components/media/scroll-rail";

// jsdom has no layout: give the scroller the sizes a real one would have.
function measured(scroller: HTMLElement, sizes: { scrollWidth: number; clientWidth: number }) {
  for (const [property, value] of Object.entries(sizes)) {
    Object.defineProperty(scroller, property, { configurable: true, value });
  }
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: 0 });
}

const rail = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="scroll-rail"]')!;
const scrollerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="scroll-rail"] > div')!;

function renderRail() {
  const view = render(
    <ScrollRail label="Sources">
      <button type="button">One</button>
      <button type="button">Two</button>
    </ScrollRail>,
  );
  return view;
}

describe("ScrollRail", () => {
  it("shows no arrows and no fades when nothing overflows", () => {
    const { container } = renderRail();
    expect(screen.queryByRole("button", { name: "Scroll left" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scroll right" })).not.toBeInTheDocument();
    expect(rail(container)).toHaveAttribute("data-at-start");
    expect(rail(container)).toHaveAttribute("data-at-end");
  });

  it("offers the end arrow when it overflows, and scrolls 80% of the width", async () => {
    const { container } = renderRail();
    const scroller = scrollerOf(container);
    measured(scroller, { scrollWidth: 2000, clientWidth: 500 });
    const scrollBy = vi.fn<(options: ScrollToOptions) => void>();
    Object.defineProperty(scroller, "scrollBy", { configurable: true, value: scrollBy });
    // A scroll measures again (on the next frame).
    fireEvent.scroll(scroller);

    fireEvent.click(await screen.findByRole("button", { name: "Scroll right" }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
    expect(rail(container)).not.toHaveAttribute("data-at-end");
    expect(rail(container)).toHaveAttribute("data-at-start");
    expect(screen.queryByRole("button", { name: "Scroll left" })).not.toBeInTheDocument();
  });

  it("brings an item into view when focus moves to it", () => {
    const { container } = renderRail();
    const two = screen.getByRole("button", { name: "Two" });
    const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
    two.scrollIntoView = scrollIntoView;
    fireEvent.focusIn(two);
    expect(scrollIntoView).toHaveBeenCalledWith({
      inline: "nearest",
      block: "nearest",
      behavior: "smooth",
    });
    expect(scrollerOf(container)).toHaveAttribute("aria-label", "Sources");
  });

  it("does not convert or prevent a vertical wheel, even with room to scroll", () => {
    const { container } = renderRail();
    const scroller = scrollerOf(container);
    measured(scroller, { scrollWidth: 2000, clientWidth: 500 });
    const down = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    scroller.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(0);
  });
});

describe("ChipRail", () => {
  it("centres the pressed chip on mount", () => {
    const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <ChipRail aria-label="Catalogs" value={["b"]}>
          <Chip value="a">A</Chip>
          <Chip value="b">B</Chip>
        </ChipRail>,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({
        inline: "center",
        block: "nearest",
        behavior: "auto",
      });
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("button", { name: "B" }));
    } finally {
      // @ts-expect-error jsdom has none, so remove ours
      delete Element.prototype.scrollIntoView;
    }
  });
});
