import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { Ambient } from "@/components/media/ambient";

const layer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-slot=ambient]");

describe("Ambient", () => {
  it("sits behind the page and out of the way of the pointer and screen readers", () => {
    const { container } = render(<Ambient src="https://art.test/a.jpg" />);
    expect(layer(container)).toHaveAttribute("aria-hidden", "true");
    expect(layer(container)).toHaveClass("-z-10", "h-[60vh]", "pointer-events-none");
  });

  it("blurs the artwork it is given", () => {
    const { container } = render(<Ambient src="https://art.test/a.jpg" />);
    expect(layer(container)).toHaveAttribute("data-tone", "art");
    expect(container.innerHTML).toContain("https://art.test/a.jpg");
    expect(container.querySelector(".blur-\\[60px\\]")).not.toBeNull();
  });

  it("shows the brand glow for the brand tone, or while there is no artwork", () => {
    const brand = render(<Ambient tone="brand" src="https://art.test/a.jpg" />);
    expect(layer(brand.container)).toHaveAttribute("data-tone", "brand");
    expect(brand.container.innerHTML).not.toContain("art.test");

    const waiting = render(<Ambient />);
    expect(layer(waiting.container)).toHaveAttribute("data-tone", "brand");
  });
});
