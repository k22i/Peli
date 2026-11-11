import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Loop } from "@/lib/ab-loop";
import { hasFocusRing } from "@/test/focus";

import { MoreMenu } from "./more-menu";

type Props = Omit<ComponentProps<typeof MoreMenu>, "open" | "onOpenChange">;

function Harness(props: Props) {
  const [open, setOpen] = useState(false);
  return <MoreMenu {...props} open={open} onOpenChange={setOpen} />;
}

const noChapters = { chapters: [], current: -1, onPick: vi.fn<(index: number) => void>() };

function loopProps(loop: Loop) {
  return { loop, onNext: vi.fn<() => void>(), onClear: vi.fn<() => void>() };
}

describe("MoreMenu", () => {
  it("opens from a button with a focus ring", async () => {
    const user = userEvent.setup();
    render(<Harness chapters={noChapters} loop={loopProps({})} />);
    const trigger = screen.getByRole("button", { name: "More" });
    expect(hasFocusRing(trigger)).toBe(true);
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "More" })).toBeInTheDocument();
  });

  it("starts, ends and stops an A–B loop", async () => {
    const user = userEvent.setup();
    const none = loopProps({});
    const { unmount } = render(<Harness chapters={noChapters} loop={none} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Start a loop here/ }));
    expect(none.onNext).toHaveBeenCalled();
    unmount();

    const half = loopProps({ a: 65 });
    const second = render(<Harness chapters={noChapters} loop={half} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: /End the loop here/ })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Forget A/ }));
    expect(half.onClear).toHaveBeenCalled();
    second.unmount();

    const both = loopProps({ a: 65, b: 90 });
    render(<Harness chapters={noChapters} loop={both} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Stop looping 1:05–1:30/ }));
    expect(both.onClear).toHaveBeenCalled();
  });

  it("lists the chapters, the one playing checked, and goes to one", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn<(index: number) => void>();
    render(
      <Harness
        chapters={{
          chapters: [
            { title: "Intro", time: 0 },
            { title: "", time: 90 },
          ],
          current: 1,
          onPick,
        }}
        loop={loopProps({})}
      />,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: /Chapters 2 of 2/ }));
    expect(await screen.findByRole("menuitemradio", { name: /Chapter 2 1:30/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Intro 0:00/ }));
    expect(onPick).toHaveBeenCalledWith(0);
  });

  it("has no Chapters row for a file with one or none", async () => {
    const user = userEvent.setup();
    render(<Harness chapters={noChapters} loop={loopProps({})} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /Chapters/ })).toBeNull();
  });
});
