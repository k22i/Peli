import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ResponsiveContextMenu,
  ResponsiveMenu,
  ResponsiveMenuGroup,
  ResponsiveMenuGroupLabel,
  ResponsiveMenuItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuSub,
  longPressMs,
} from "@/components/ui/responsive-menu";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import { sheetsOpen } from "@/lib/sheets";
import { onCompactIOS } from "@/test/ios";

vi.mock("@/lib/haptics", () => ({ haptic: vi.fn<(kind: string) => void>() }));
const { haptic } = await import("@/lib/haptics");

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});
// A pointer event at a given time (jsdom stamps events with the real clock).
function pointer(
  type: "pointerDown" | "pointerMove" | "pointerUp",
  target: Element,
  clientY: number,
  t: number,
) {
  const event = createEvent[type](target, { button: 0, clientY, pointerId: 1 });
  Object.defineProperty(event, "timeStamp", { value: t });
  fireEvent(target, event);
}

const compact = () => {
  restore = onCompactIOS();
};

const actions = {
  play: vi.fn<() => void>(),
  remove: vi.fn<() => void>(),
  rate: vi.fn<(value: unknown) => void>(),
};
afterEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
});

// The same items as a caller writes them: two groups, a submenu with radio
// items, a destructive item.
function Items({ rating = "0" }: { rating?: string }) {
  return (
    <>
      <ResponsiveMenuGroup>
        <ResponsiveMenuGroupLabel>Watch</ResponsiveMenuGroupLabel>
        <ResponsiveMenuItem onClick={actions.play}>
          <Play aria-hidden />
          Play
        </ResponsiveMenuItem>
      </ResponsiveMenuGroup>
      <ResponsiveMenuSeparator />
      <ResponsiveMenuSub title="Rating" label="Rate…">
        <ResponsiveMenuRadioGroup value={rating} onValueChange={actions.rate}>
          {["1", "2", "3"].map((value) => (
            <ResponsiveMenuRadioItem key={value} value={value}>
              {value}
            </ResponsiveMenuRadioItem>
          ))}
        </ResponsiveMenuRadioGroup>
      </ResponsiveMenuSub>
      <ResponsiveMenuItem variant="destructive" onClick={actions.remove}>
        <Trash2 aria-hidden />
        Remove
      </ResponsiveMenuItem>
    </>
  );
}

function ButtonMenu() {
  return (
    <ResponsiveMenu
      label="Options"
      header={<p>Header</p>}
      trigger={{ "aria-label": "More", children: "⋯" }}
    >
      <Items rating="2" />
    </ResponsiveMenu>
  );
}

function CardMenu() {
  return (
    <ResponsiveContextMenu label="Dune" header={<p>Dune 2021</p>} items={<Items />}>
      <button type="button" onClick={actions.play} data-row-item>
        Dune card
      </button>
    </ResponsiveContextMenu>
  );
}

describe("ResponsiveMenu on desktop", () => {
  it("is a popover menu with the same items", async () => {
    render(<ButtonMenu />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The sheet's header is the iPhone's only.
    expect(screen.queryByText("Header")).toBeNull();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Play" }));
    expect(actions.play).toHaveBeenCalledOnce();
    expect(sheetsOpen()).toBe(0);
  });

  it("opens a card's menu on a right-click", async () => {
    render(<CardMenu />);
    fireEvent.contextMenu(screen.getByText("Dune card"));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove" }));
    expect(actions.remove).toHaveBeenCalledOnce();
  });
});

describe("ResponsiveMenu on the iPhone", () => {
  it("is a modal bottom sheet, named, with the header and the same items", async () => {
    compact();
    render(<ButtonMenu />);
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Options" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAttribute("data-slot", "bottom-sheet");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(sheet).getByText("Header")).toBeInTheDocument();
    expect(within(sheet).getByText("Watch")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Remove" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    expect(sheetsOpen()).toBe(1);

    await userEvent.click(within(sheet).getByRole("button", { name: "Play" }));
    expect(actions.play).toHaveBeenCalledOnce();
    // Choosing a row closes the sheet and gives the trigger its focus back.
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sheetsOpen()).toBe(0);
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  });

  it("pushes a submenu as a second page, with a Back row", async () => {
    compact();
    render(<ButtonMenu />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog");

    await userEvent.click(within(sheet).getByRole("button", { name: "Rate…" }));
    expect(within(sheet).queryByRole("button", { name: "Play" })).toBeNull();
    expect(within(sheet).queryByText("Header")).toBeNull();
    const back = within(sheet).getByRole("button", { name: "Back" });
    await vi.waitFor(() => expect(back).toHaveFocus());
    expect(within(sheet).getByRole("radio", { name: "2" })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(back);
    expect(within(sheet).getByRole("button", { name: "Play" })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(within(sheet).getByRole("button", { name: "Rate…" })).toHaveFocus(),
    );

    await userEvent.click(within(sheet).getByRole("button", { name: "Rate…" }));
    await userEvent.click(within(sheet).getByRole("radio", { name: "3" }));
    expect(actions.rate).toHaveBeenCalledWith("3");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape and on the backdrop", async () => {
    compact();
    render(<ButtonMenu />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("dialog");
    const backdrop = document.querySelector<HTMLElement>('[data-slot="bottom-sheet-backdrop"]');
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the grabber is flicked down, and stays when barely moved", async () => {
    compact();
    render(<ButtonMenu />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog");
    Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: 400 });
    const handle = sheet.querySelector<HTMLElement>('[data-slot="bottom-sheet-handle"]')!;

    // 10 px in 400 ms: neither far nor fast.
    pointer("pointerDown", handle, 100, 0);
    pointer("pointerMove", handle, 110, 400);
    pointer("pointerUp", handle, 110, 410);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 60 px in 40 ms: a flick.
    pointer("pointerDown", handle, 100, 1000);
    pointer("pointerMove", handle, 130, 1020);
    pointer("pointerMove", handle, 160, 1040);
    pointer("pointerUp", handle, 160, 1045);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens a card's sheet on a 500 ms press, with a haptic, and the lift doesn't tap the card", async () => {
    compact();
    vi.useFakeTimers();
    render(<CardMenu />);
    const card = screen.getByText("Dune card");

    fireEvent.pointerDown(card, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    expect(card.parentElement).toHaveAttribute("data-pressing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(longPressMs - 1);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(haptic).toHaveBeenCalledWith("light");
    expect(screen.getByRole("dialog", { name: "Dune" })).toBeInTheDocument();
    expect(card.parentElement).not.toHaveAttribute("data-pressing");

    fireEvent.pointerUp(card, { pointerType: "touch" });
    fireEvent.click(card);
    expect(actions.play).not.toHaveBeenCalled();
    expect(screen.getByText("Dune 2021")).toBeInTheDocument();
  });

  it("doesn't open a card's sheet when the finger moves (a scroll)", async () => {
    compact();
    vi.useFakeTimers();
    render(<CardMenu />);
    const card = screen.getByText("Dune card");
    fireEvent.pointerDown(card, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { pointerType: "touch", clientX: 10, clientY: 40 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(longPressMs * 2);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(card);
    expect(actions.play).toHaveBeenCalledOnce();
  });
});

function Sort() {
  const [value, setValue] = useState<"added" | "name">("added");
  return (
    <ResponsiveSelect
      items={[
        { value: "added", label: "Date added" },
        { value: "name", label: "Name" },
      ]}
      value={value}
      onValueChange={(next) => next && setValue(next)}
      aria-label="Sort"
      title="Sort by"
    />
  );
}

describe("ResponsiveSelect", () => {
  it("is a listbox popup on desktop", async () => {
    render(<Sort />);
    const trigger = screen.getByRole("combobox", { name: "Sort" });
    expect(trigger).toHaveTextContent("Date added");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "Name" }));
    await vi.waitFor(() => expect(trigger).toHaveTextContent("Name"));
  });

  it("is one rounded surface: the popup, with the list straight inside it", async () => {
    render(<Sort />);
    await userEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    const list = await screen.findByRole("listbox");
    const popup = document.querySelector<HTMLElement>('[data-slot="select-popup"]')!;
    // A second box inside the popup drew square corners around the rounded
    // one; the popup is the whole surface, so its radius is the radius seen.
    expect(popup).toHaveClass("rounded-2xl");
    expect(list.parentElement).toBe(popup);
  });

  it("is a sheet of rows with the chosen one checked on the iPhone", async () => {
    compact();
    render(<Sort />);
    const trigger = screen.getByRole("button", { name: "Sort" });
    expect(trigger).toHaveTextContent("Date added");
    await userEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "Sort by" });
    expect(within(sheet).getByRole("radio", { name: "Date added" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(sheet).getByRole("radio", { name: "Name" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveTextContent("Name");
  });
});
