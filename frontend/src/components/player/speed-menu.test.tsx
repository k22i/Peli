import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { hasFocusRing } from "@/test/focus";

import { SpeedMenu } from "./speed-menu";

function Harness({ speed, onChange }: { speed: number; onChange: (speed: number) => void }) {
  const [open, setOpen] = useState(false);
  return <SpeedMenu speed={speed} onChange={onChange} open={open} onOpenChange={setOpen} />;
}

describe("SpeedMenu", () => {
  it("shows the speed and picks another", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(speed: number) => void>();
    render(<Harness speed={1} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Playback speed, 1×" });
    expect(trigger).toHaveTextContent("1×");
    expect(hasFocusRing(trigger)).toBe(true);
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: /^1× Normal/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it("opens and picks by keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(speed: number) => void>();
    render(<Harness speed={1} onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole("button", { name: /Playback speed/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitemradio", { name: "4×" });
    expect(hasFocusRing(item)).toBe(true);
    item.focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("counts a watch party's nudge as the step it's near", async () => {
    const user = userEvent.setup();
    render(<Harness speed={1.03} onChange={vi.fn<(speed: number) => void>()} />);
    await user.click(screen.getByRole("button", { name: /Playback speed/ }));
    expect(screen.getByRole("menuitemradio", { name: /^1× Normal/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
