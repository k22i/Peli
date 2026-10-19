import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { sections } from "@/sections";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

describe("router", () => {
  it("caps the top-level navigation at 6 items", () => {
    expect(sections.length).toBeLessThanOrEqual(6);
  });

  it.each(sections)("renders the $label section at $to", async ({ label, to }) => {
    await renderApp(to);

    expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
  });

  it("navigates between sections from the nav", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    await user.click(screen.getByRole("link", { name: "Movies" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Movies" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/movies");
    expect(screen.getByRole("link", { name: "Movies" })).toHaveClass("active");
  });

  it("shows the app version from the Go binding on Settings", async () => {
    await renderApp("/settings");

    expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
  });
});
