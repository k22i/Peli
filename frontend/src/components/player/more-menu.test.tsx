import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Loop } from "@/lib/ab-loop";
import type { SleepChoice } from "@/lib/sleep-timer";
import { hasFocusRing } from "@/test/focus";

import { MoreMenu } from "./more-menu";

type Props = Omit<ComponentProps<typeof MoreMenu>, "open" | "onOpenChange">;

function Harness(props: Props) {
  const [open, setOpen] = useState(false);
  return <MoreMenu {...props} open={open} onOpenChange={setOpen} />;
}

const noSleep = {
  choice: "off" as const,
  hint: undefined,
  episodeKnown: true,
  onChange: vi.fn<(choice: SleepChoice) => void>(),
};
const noStats = { open: false, onToggle: vi.fn<() => void>() };
const noChapters = { chapters: [], current: -1, onPick: vi.fn<(index: number) => void>() };

function loopProps(loop: Loop) {
  return { loop, onNext: vi.fn<() => void>(), onClear: vi.fn<() => void>() };
}

// The menu mounts a moment after the click, so wait for it.
async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More" }));
  await screen.findByRole("menu", { name: "More" });
}

describe("MoreMenu", () => {
  it("opens from a button with a focus ring", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        chapters={noChapters}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
        loop={loopProps({})}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    expect(hasFocusRing(trigger)).toBe(true);
    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "More" })).toBeInTheDocument();
  });

  it("starts, ends and stops an A–B loop", async () => {
    const user = userEvent.setup();
    const none = loopProps({});
    const { unmount } = render(
      <Harness
        chapters={noChapters}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
        loop={none}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Start a loop here/ }));
    expect(none.onNext).toHaveBeenCalled();
    unmount();

    const half = loopProps({ a: 65 });
    const second = render(
      <Harness
        chapters={noChapters}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
        loop={half}
      />,
    );
    await openMore(user);
    expect(screen.getByRole("menuitem", { name: /End the loop here/ })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Forget A/ }));
    expect(half.onClear).toHaveBeenCalled();
    second.unmount();

    const both = loopProps({ a: 65, b: 90 });
    render(
      <Harness
        chapters={noChapters}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
        loop={both}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Stop looping 1:05–1:30/ }));
    expect(both.onClear).toHaveBeenCalled();
  });

  it("lists the chapters, the one playing checked, and goes to one", async () => {
    // Base UI turns pointer events off on the parent menu while a submenu is open.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
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
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Chapters 2 of 2/ }));
    expect(await screen.findByRole("menuitemradio", { name: /Chapter 2 1:30/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Keyboard, as in the sleep timer test below.
    screen.getByRole("menuitemradio", { name: /Intro 0:00/ }).focus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(0);
  });

  it("has no Chapters row for a file with one or none", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        chapters={noChapters}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={noSleep}
        loop={loopProps({})}
      />,
    );
    await openMore(user);
    expect(screen.queryByRole("menuitem", { name: /Chapters/ })).toBeNull();
  });

  it("takes a screenshot with the subtitles showing, or without", async () => {
    const user = userEvent.setup();
    const onScreenshot = vi.fn<(subtitles: boolean) => void>();
    render(
      <Harness
        chapters={noChapters}
        loop={loopProps({})}
        onScreenshot={onScreenshot}
        stats={noStats}
        sleep={noSleep}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Take a screenshot/ }));
    expect(onScreenshot).toHaveBeenLastCalledWith(true);
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Without subtitles/ }));
    expect(onScreenshot).toHaveBeenLastCalledWith(false);
  });

  it("turns the stats overlay on and off", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn<() => void>();
    render(
      <Harness
        chapters={noChapters}
        loop={loopProps({})}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={{ open: true, onToggle }}
        sleep={noSleep}
      />,
    );
    await openMore(user);
    const item = screen.getByRole("menuitemcheckbox", { name: /Playback stats/ });
    expect(item).toHaveAttribute("aria-checked", "true");
    await user.click(item);
    expect(onToggle).toHaveBeenCalled();
  });

  it("sets the sleep timer", async () => {
    // Base UI turns pointer events off on the parent menu while a submenu is open.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn<(choice: SleepChoice) => void>();
    render(
      <Harness
        chapters={noChapters}
        loop={loopProps({})}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={{ ...noSleep, choice: "30", hint: "12 min", onChange }}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Sleep timer 12 min/ }));
    expect(await screen.findByRole("menuitemradio", { name: "30 minutes" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Picked with the keyboard: user-event's pointer sequence on a submenu
    // item doesn't select it in jsdom (Base UI sets pointer-events: none on
    // the parent popup while the submenu is open).
    screen.getByRole("menuitemradio", { name: "End of episode" }).focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("episode");
  });

  it("offers no end of episode for a file of unknown length", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        chapters={noChapters}
        loop={loopProps({})}
        onScreenshot={vi.fn<(subtitles: boolean) => void>()}
        stats={noStats}
        sleep={{ ...noSleep, episodeKnown: false }}
      />,
    );
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: /Sleep timer/ }));
    await screen.findByRole("menuitemradio", { name: "15 minutes" });
    expect(screen.queryByRole("menuitemradio", { name: "End of episode" })).toBeNull();
  });
});
