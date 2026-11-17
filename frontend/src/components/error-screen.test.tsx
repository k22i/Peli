import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Service as Diagnostics } from "@bindings/diagnostics";
import { resetReports } from "@/lib/diagnostics";
import { onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

// A component in Settings › About that throws while the flag is up, as a
// bug in any page would.
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/settings/update-rows", () => ({
  UpdateRows: () => {
    if (broken.on) throw new Error("the rows broke");
    return null;
  },
}));

afterEach(() => {
  broken.on = false;
  resetReports();
  vi.mocked(Diagnostics.Info).mockResolvedValue({ dev: false, logs: false });
  vi.mocked(Diagnostics.LastCrash).mockResolvedValue(null);
});

describe("the error screen", () => {
  it("replaces a page that throws, reports it, and goes Home (desktop)", async () => {
    // React logs the error it caught; that's expected here.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    broken.on = true;
    const user = userEvent.setup();
    // Rendering, failing and rendering the boundary takes a while under load.
    const { router } = await renderApp("/settings?section=about", { shell: false });
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: "Something went wrong" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The message is in the disclosure; the stack only in the report.
    expect(screen.getByText("the rows broke")).toBeInTheDocument();
    expect(Diagnostics.Report).toHaveBeenCalledWith(
      "render",
      "Error: the rows broke",
      expect.stringContaining("the rows broke"),
    );
    // The shell stays around a page that failed.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();

    broken.on = false;
    await user.click(screen.getByRole("button", { name: "Go Home" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Something went wrong" }),
      ).not.toBeInTheDocument(),
    );
    quiet.mockRestore();
  });

  it("is not in the desktop's Settings › About", async () => {
    await renderApp("/settings?section=about");
    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    expect(screen.queryByText("Diagnostics")).not.toBeInTheDocument();
    expect(Diagnostics.Info).not.toHaveBeenCalled();
  });
});

describe("Settings › About › Diagnostics on iOS", () => {
  it("shares the logs and shows the last crash", async () => {
    onIOS();
    vi.mocked(Diagnostics.Info).mockResolvedValue({ dev: false, logs: true });
    vi.mocked(Diagnostics.LastCrash).mockResolvedValue({
      time: "2026-11-17T10:00:00Z",
      name: "20261117-095000.txt",
      previous: true,
    });
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    expect(await screen.findByText("Last crash")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Share logs" }));
    expect(Diagnostics.ShareLogs).toHaveBeenCalled();
    // Not a dev build: no crash tests.
    expect(screen.queryByText("Crash tests (dev build)")).not.toBeInTheDocument();
  });

  it("runs the rig's render error from a dev build", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    onIOS();
    vi.mocked(Diagnostics.Info).mockResolvedValue({ dev: true, logs: true });
    const user = userEvent.setup();
    await renderApp("/settings?section=about");

    expect(await screen.findByText("Crash tests (dev build)")).toBeInTheDocument();
    expect(window.peliDev?.allocateUntilKilled).toBeTypeOf("function");
    await user.click(
      screen.getByRole("button", { name: "Run", description: "Shows the error screen." }),
    );
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: "Something went wrong" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(Diagnostics.Report).toHaveBeenCalledWith(
      "render",
      "Error: pelidev: a render error, on purpose",
      expect.any(String),
    );
    quiet.mockRestore();
  });
});
