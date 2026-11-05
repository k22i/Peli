import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import { PosterCard } from "@/components/media/cards";
import { Row, RowGroup, cardRem } from "@/components/media/row";
import { indexCss } from "@/test/index-css";

const titles = (count: number, prefix = "Title") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

function PosterRow({ title, items }: { title: string; items: string[] }) {
  return (
    <Row
      title={title}
      items={items}
      getKey={(item) => item}
      renderItem={(item) => <PosterCard title={item} />}
    />
  );
}

const cardsIn = (name: string) =>
  within(screen.getByRole("region", { name })).getAllByRole("button");
const tabStops = (name: string) => cardsIn(name).filter((card) => card.tabIndex === 0);

describe("Row", () => {
  it("sizes cards as index.css does", () => {
    for (const [shape, rem] of Object.entries(cardRem)) {
      expect(indexCss).toContain(`--container-${shape}: ${rem}rem;`);
    }
  });

  it("mounts only the cards near the viewport", () => {
    render(<PosterRow title="Popular" items={titles(200)} />);

    // 1280 px of 264 px slots (240 px cards, 24 px gap), plus overscan.
    const cards = cardsIn("Popular");
    expect(cards.length).toBeGreaterThan(3);
    expect(cards.length).toBeLessThan(20);
    expect(screen.getByRole("button", { name: "Title 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Title 200" })).toBeNull();
  });

  it("walks every card with the keyboard, mounting the one it moves to", async () => {
    const user = userEvent.setup();
    render(<PosterRow title="Popular" items={titles(200)} />);

    expect(tabStops("Popular")).toEqual([screen.getByRole("button", { name: "Title 1" })]);

    await user.tab();
    expect(screen.getByRole("button", { name: "Title 1" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Title 2" })).toHaveFocus();

    // Far off-screen: still mounted once it's the active card.
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Title 200" })).toHaveFocus();
    expect(tabStops("Popular")).toEqual([screen.getByRole("button", { name: "Title 200" })]);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Title 200" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Title 199" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "Title 1" })).toHaveFocus();
  });

  it("keeps focus on its card when items arrive ahead of it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PosterRow title="Results" items={titles(20)} />);

    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    const focused = screen.getByRole("button", { name: "Title 3" });
    expect(focused).toHaveFocus();

    rerender(<PosterRow title="Results" items={[...titles(30, "Early"), ...titles(20)]} />);
    expect(focused).toHaveFocus();
    expect(tabStops("Results")).toEqual([focused]);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Title 4" })).toHaveFocus();
  });

  it("moves between rows with ↑ and ↓ inside a RowGroup", async () => {
    const user = userEvent.setup();
    render(
      <RowGroup>
        <PosterRow title="First" items={titles(50, "First")} />
        <PosterRow title="Second" items={titles(50, "Second")} />
      </RowGroup>,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "First 1" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Second 1" })).toHaveFocus();
    // The last row: nowhere further down.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Second 1" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "First 1" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "First 1" })).toHaveFocus();

    // Leaving a row and coming back lands on the card it was left at.
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Second 1" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "First 3" })).toHaveFocus();
  });

  it("leaves ↑ and ↓ to the page outside a RowGroup", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PosterRow title="First" items={titles(5, "First")} />
        <PosterRow title="Second" items={titles(5, "Second")} />
      </>,
    );

    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "First 1" })).toHaveFocus();
  });
});
