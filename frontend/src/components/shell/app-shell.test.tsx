import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps the section current while a page's search (a chip, a filter) changes", async () => {
    await renderApp("/shows?genre=Drama");

    const nav = screen.getByRole("navigation", { name: "Main" });

    expect(within(nav).getByRole("link", { name: "Shows" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("lists the browse sections, then Library, then Search", async () => {
    await renderApp("/");

    const nav = screen.getByRole("navigation", { name: "Main" });

    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Home", "Movies", "Shows", "Anime", "Library", expect.stringContaining("Search")]);
  });

  it("marks only the current section with the sun, and moves it with the route", async () => {
    const user = userEvent.setup();
    await renderApp("/shows");

    const nav = screen.getByRole("navigation", { name: "Main" });
    const pills = () => [...nav.querySelectorAll('[data-slot="nav-sun"]')];

    expect(pills()).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "Shows" }).contains(pills()[0]!)).toBe(true);
    expect(pills()[0]).toHaveAttribute("aria-hidden", "true");

    await user.click(within(nav).getByRole("link", { name: "Movies" }));
    await heading("Movies");

    expect(pills()).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "Movies" }).contains(pills()[0]!)).toBe(true);
  });

  it("frosts the top bar once the page is scrolled", async () => {
    await renderApp("/");
    const content = document.getElementById("content");
    expect(content).not.toHaveAttribute("data-scrolled");

    content!.scrollTop = 120;
    content!.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(content).toHaveAttribute("data-scrolled"));
  });

  it("reaches every section from the keyboard and focuses the new page", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("link", { name: "Movies" })).toHaveFocus();
    // Arrow keys follow the order on screen: Home to Anime, Library, then
    // Search, and round again.
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("link", { name: "Search" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("link", { name: "Library" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
    await user.keyboard("{End}{ArrowLeft}{Enter}");

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

  it("jumps to a section with Control+digit", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.keyboard("{Control>}3{/Control}");

    expect(await heading("Shows")).toBeInTheDocument();
    expect(document.getElementById("content")).toHaveFocus();
  });

  it("jumps to Search with Meta+digit, and leaves focus in its field", async () => {
    const user = userEvent.setup();
    await renderApp("/");

    await user.keyboard("{Meta>}5{/Meta}");

    expect(await heading("Search")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus());
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

  it("opens Settings at the pane last used", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings?section=about");
    expect(await screen.findByRole("heading", { level: 2, name: "About" })).toBeInTheDocument();

    await user.keyboard("{Meta>}1{/Meta}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await user.keyboard("{Meta>},{/Meta}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(router.state.location.search).toEqual({ section: "about" });
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

    // The picker (#24): profiles.test.tsx switches with it.
    expect(within(menu).getByRole("menuitem", { name: "Switch profile" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
    // A guest has nothing to sign out of, and can sign in instead (#23).
    expect(within(menu).queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Sign in to Nuvio" })).toBeVisible();
    // The header: the profile's name and how it is signed in (#122).
    expect(within(menu).getByText("Not signed in")).toBeVisible();

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
