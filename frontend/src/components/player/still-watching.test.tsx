import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { hasFocusRing } from "@/test/focus";

import { StillWatching } from "./still-watching";

describe("StillWatching", () => {
  it("asks, with the answer to play on focused", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn<() => void>();
    const onStop = vi.fn<() => void>();
    render(
      <StillWatching
        title="Severance"
        episodes={3}
        mini={false}
        onContinue={onContinue}
        onStop={onStop}
      />,
    );
    expect(
      screen.getByRole("alertdialog", { name: "Still watching Severance?" }),
    ).toHaveAccessibleDescription(
      "3 episodes have played without a break. The next one waits for you.",
    );
    const play = screen.getByRole("button", { name: "Play the next episode" });
    expect(play).toHaveFocus();
    expect(hasFocusRing(play)).toBe(true);
    await user.keyboard("{Enter}");
    expect(onContinue).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
  });
});
