import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { TabBar } from "@/components/shell/tab-bar";
import type { TabBarModel } from "@/components/shell/use-tab-bar";

// Scrolled down far enough to minimise (lib/tab-bar.ts's tracker).
const scrolledDown: TabBarModel = {
  active: "/",
  minimized: true,
  hidden: false,
  select: vi.fn<TabBarModel["select"]>(),
  expand: vi.fn<TabBarModel["expand"]>(),
};

async function renderBar(centred: boolean) {
  const rootRoute = createRootRoute({
    component: () => <TabBar model={scrolledDown} centred={centred} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByRole("navigation", { name: "Main" });
}

describe("the CSS tab bar", () => {
  it("shrinks to the current tab on a phone scrolled down", async () => {
    const bar = await renderBar(false);
    expect(bar).toHaveAttribute("data-minimized");
  });

  it("never shrinks on the iPad (#138)", async () => {
    const bar = await renderBar(true);
    expect(bar).not.toHaveAttribute("data-minimized");
  });
});
