import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { themeStorageKey } from "@/lib/theme";
import { hasFocusRing, keyboardReachable } from "@/test/focus";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

async function renderGallery() {
  const app = await renderApp("/gallery");
  await screen.findByRole("heading", { level: 1, name: "Design system" });
  return app;
}

describe("gallery", () => {
  it("is reachable from Settings, outside the main nav", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings");

    await user.click(await screen.findByRole("link", { name: "Design system" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/gallery");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: /design system/i })).toBeNull();
  });

  it("shows every core component", async () => {
    await renderGallery();

    for (const name of [
      "Hero",
      "Rows",
      "Cards",
      "Buttons",
      "Chips and badges",
      "Scroll rail",
      "Glass buttons",
      "Player bar",
      "Overlays",
      "Skeletons",
      "Stream picker",
      "Long rows",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "The Lighthouse Keeper" })).toBeInTheDocument();
    expect(screen.getAllByText("84% watched").length).toBeGreaterThan(0);
  });

  it("shows the materials, the type scale and the shell", async () => {
    await renderGallery();

    for (const name of ["Type", "Type in use", "Materials", "Shell"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    // The player bar's seek bar and the glass buttons are the real components.
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back 10 seconds" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cast" })).toBeInTheDocument();
  });

  it("gives every keyboard-reachable element a visible focus ring", async () => {
    await renderGallery();

    const elements = keyboardReachable();
    expect(elements.length).toBeGreaterThan(40);
    const missing = elements.filter((element) => !hasFocusRing(element));
    expect(missing.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  });

  it("makes a row one Tab stop, walked with the arrow keys", async () => {
    const user = userEvent.setup();
    await renderGallery();

    const row = screen.getByRole("region", { name: "Popular movies" });
    // Cards mount and unmount as the row scrolls: look them up afresh.
    const card = (name: string) => within(row).getByRole("button", { name: new RegExp(name) });
    const cards = within(row).getAllByRole("button");
    expect(cards.filter((each) => each.tabIndex === 0)).toEqual([card("Low Tide")]);

    card("Low Tide").focus();
    await user.keyboard("{ArrowRight}");
    expect(card("The Lighthouse Keeper")).toHaveFocus();
    expect(card("The Lighthouse Keeper").tabIndex).toBe(0);
    expect(card("Low Tide").tabIndex).toBe(-1);

    await user.keyboard("{End}");
    expect(card("Coral City")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(card("Coral City")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(card("Low Tide")).toHaveFocus();

    // ↑ goes to the row above.
    await user.keyboard("{ArrowUp}");
    expect(
      within(screen.getByRole("region", { name: "Continue watching" })).getByRole("button", {
        name: /Northern Current/,
      }),
    ).toHaveFocus();
  });

  it("switches and remembers the appearance", async () => {
    const user = userEvent.setup();
    await renderGallery();

    const appearance = screen.getByRole("group", { name: "Appearance" });
    await user.click(within(appearance).getByRole("button", { name: "Dark" }));
    expect(localStorage.getItem(themeStorageKey)).toBe("dark");
    expect(within(appearance).getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Pressing the current option again keeps it rather than clearing it.
    await user.click(within(appearance).getByRole("button", { name: "Dark" }));
    expect(localStorage.getItem(themeStorageKey)).toBe("dark");

    await user.click(within(appearance).getByRole("button", { name: "System" }));
    expect(localStorage.getItem(themeStorageKey)).toBeNull();
  });
});
