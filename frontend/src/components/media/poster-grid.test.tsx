import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import { PosterCard } from "@/components/media/cards";
import { PosterGrid } from "@/components/media/poster-grid";

function Page({ count }: { count: number }) {
  return (
    // The app shell's scroll container.
    <div id="content" style={{ overflowY: "auto" }}>
      <PosterGrid
        label="Movies"
        items={Array.from({ length: count }, (_, index) => `Title ${index + 1}`)}
        getKey={(item) => item}
        renderItem={(item) => <PosterCard title={item} />}
      />
    </div>
  );
}

const card = (name: string) => screen.getByRole("button", { name });

describe("PosterGrid", () => {
  it("lays posters out in as many columns as fit and mounts only the first rows", () => {
    render(<Page count={1000} />);

    const cards = within(screen.getByRole("list", { name: "Movies" })).getAllByRole("button");
    // 1280 px fits seven 160 px posters; 800 px shows a few rows, plus overscan.
    expect(cards.length % 7).toBe(0);
    expect(cards.length).toBeGreaterThanOrEqual(14);
    expect(cards.length).toBeLessThan(60);
    expect(screen.queryByRole("button", { name: "Title 1000" })).toBeNull();
  });

  it("walks the grid with the arrow keys as one Tab stop", async () => {
    const user = userEvent.setup();
    render(<Page count={1000} />);

    await user.tab();
    expect(card("Title 1")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(card("Title 2")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(card("Title 9")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(card("Title 1")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(card("Title 1")).toHaveFocus();

    // Far below the mounted rows.
    await user.keyboard("{End}");
    expect(card("Title 1000")).toHaveFocus();
    expect(card("Title 1000").tabIndex).toBe(0);
    expect(card("Title 1").tabIndex).toBe(-1);
    await user.keyboard("{Home}");
    expect(card("Title 1")).toHaveFocus();
  });

  it("goes down to the last card from above a short last row", async () => {
    const user = userEvent.setup();
    // Two rows of seven, then three.
    render(<Page count={17} />);

    await user.tab();
    await user.keyboard("{End}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowUp}");
    expect(card("Title 7")).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(card("Title 13")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(card("Title 17")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(card("Title 17")).toHaveFocus();
  });
});
