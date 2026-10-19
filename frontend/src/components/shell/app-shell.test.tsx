import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppShell } from "@/components/shell/app-shell";
import { createQueryClient } from "@/lib/query";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

describe("app shell", () => {
  it("makes the nav a single Tab stop on the current section", async () => {
    await renderApp("/shows");

    const nav = screen.getByRole("navigation", { name: "Main" });
    const tabbable = within(nav)
      .getAllByRole("link")
      .filter((link) => link.tabIndex === 0);

    expect(tabbable).toEqual([within(nav).getByRole("link", { name: "Shows" })]);
  });

  it("reaches every section from the keyboard and focuses the new page", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: "Movies" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("link", { name: "Library" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
    await user.keyboard("{End}{Enter}");

    expect(await heading("Library")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/library");
    expect(document.getElementById("content")).toHaveFocus();
  });

  it("does not move focus on a mouse click", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.click(screen.getByRole("link", { name: "Movies" }));

    expect(await heading("Movies")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Movies" })).toHaveFocus();
  });

  it.each([
    ["Control", "{Control>}3{/Control}"],
    ["Meta", "{Meta>}5{/Meta}"],
  ])("jumps to a section with %s+digit", async (_, keys) => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.keyboard(keys);

    const label = keys.includes("3") ? "Shows" : "Search";
    expect(await heading(label)).toBeInTheDocument();
    expect(document.getElementById("content")).toHaveFocus();
  });

  it.each([
    ["Control", "{Control>},{/Control}"],
    ["Meta", "{Meta>},{/Meta}"],
  ])("opens Settings with %s+comma", async (_, keys) => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.keyboard(keys);

    expect(await heading("Settings")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
    expect(document.getElementById("content")).toHaveFocus();
  });

  it("skips to the content pane", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.tab();
    await user.keyboard("{Enter}");

    expect(document.getElementById("content")).toHaveFocus();
  });

  it("keeps the shell mounted across navigation", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const main = screen.getByRole("main");

    await user.click(screen.getByRole("link", { name: "Anime" }));
    expect(await heading("Anime")).toBeInTheDocument();

    expect(screen.getByRole("navigation", { name: "Main" })).toBe(nav);
    expect(screen.getByRole("main")).toBe(main);
  });

  it("holds profiles, addons and settings in the profile menu", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.click(screen.getByRole("button", { name: "Profile: Guest" }));
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByRole("menuitem", { name: "Switch profile" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(await heading("Settings")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");

    await user.click(screen.getByRole("button", { name: "Profile: Guest" }));
    await user.click(await screen.findByRole("menuitem", { name: "Addons" }));
    expect(await heading("Addons")).toBeInTheDocument();
  });

  it("opens the profile menu from the keyboard", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    screen.getByRole("button", { name: "Profile: Guest" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it('renders a route with chrome: "none" without the shell', async () => {
    const root = createRootRoute({
      component: () => (
        <AppShell>
          <Outlet />
        </AppShell>
      ),
    });
    const player = createRoute({
      getParentRoute: () => root,
      path: "/player",
      staticData: { chrome: "none" },
      component: () => <h1>Player</h1>,
    });
    const router = createRouter({
      routeTree: root.addChildren([player]),
      history: createMemoryHistory({ initialEntries: ["/player"] }),
    });

    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await heading("Player")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
  });
});
