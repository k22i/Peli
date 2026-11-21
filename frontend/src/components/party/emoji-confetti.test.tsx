import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { burst, EmojiConfetti } from "@/components/party/emoji-confetti";

// jsdom ships no canvas. A null 2d context has to mean "nothing to draw", not a
// thrown error, and defining the method keeps jsdom from logging its own "not
// implemented" on every mount.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

describe("EmojiConfetti", () => {
  it("ignores a burst when no layer is mounted", () => {
    expect(() => burst("🎉")).not.toThrow();
  });

  it("is an inert, hidden layer", () => {
    const { container } = render(<EmojiConfetti />);
    const layer = container.firstElementChild;
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer?.className).toContain("absolute");
    expect(layer?.className).toContain("pointer-events-none");
  });

  it("takes bursts while mounted and stops taking them after unmounting", () => {
    const { unmount } = render(<EmojiConfetti />);
    expect(() => burst("🔥")).not.toThrow();
    unmount();
    expect(() => burst("😂")).not.toThrow();
  });
});
