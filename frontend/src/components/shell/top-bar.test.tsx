import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FocusBar } from "@/components/shell/top-bar";

const Window = vi.hoisted(() => ({
  Minimise: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  ToggleMaximise: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  Close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  IsMaximised: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
}));

vi.mock("@wailsio/runtime", () => ({
  Window,
  Events: {
    On: vi.fn<() => () => void>(() => () => {}),
    Types: {
      Common: {
        WindowMaximise: "common:WindowMaximise",
        WindowUnMaximise: "common:WindowUnMaximise",
        WindowRestore: "common:WindowRestore",
      },
    },
  },
}));

// The bare bar the screens before the app use; TopBar shares its caption
// buttons and is covered by the app shell's tests.
describe("focus bar", () => {
  beforeEach(() => {
    Window.IsMaximised.mockResolvedValue(false);
  });

  it("draws caption buttons on Windows", async () => {
    const user = userEvent.setup();
    render(<FocusBar platform="windows" />);

    await user.click(screen.getByRole("button", { name: "Minimise" }));
    await user.click(screen.getByRole("button", { name: "Maximise" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(Window.Minimise).toHaveBeenCalledOnce();
    expect(Window.ToggleMaximise).toHaveBeenCalledOnce();
    expect(Window.Close).toHaveBeenCalledOnce();
  });

  it("offers Restore once the window is maximised", async () => {
    Window.IsMaximised.mockResolvedValue(true);
    render(<FocusBar platform="windows" />);

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("leaves macOS's traffic lights to the OS", () => {
    const { container } = render(<FocusBar platform="mac" />);

    expect(container.querySelector("[data-slot=top-bar]")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["linux", "browser"] as const)("keeps the native frame on %s", (platform) => {
    const { container } = render(<FocusBar platform={platform} />);

    expect(container).toBeEmptyDOMElement();
  });
});
