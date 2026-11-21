import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Service as Party } from "@bindings/party";
import type { DeviceSettings } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { deviceSettings, partyMember, partyState } from "@/test/fixtures";

import { PartyDock } from "./party-dock";

// The device's settings as the Go store answers them, and the saves made
// onto them; the dock's setting lives there (ADR-0051).
const store = vi.hoisted(() => ({
  device: undefined as DeviceSettings | undefined,
  saves: [] as DeviceSettings[],
}));

vi.mock("@bindings/store", () => ({
  Service: {
    DeviceSettings: () => Promise.resolve(store.device),
    SaveDeviceSettings: vi.fn((settings: DeviceSettings) => {
      store.saves.push(settings);
      store.device = settings;
      return Promise.resolve();
    }),
  },
}));

function renderDock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn<() => void>();
  render(
    <QueryClientProvider client={client}>
      <PartyDock onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

// Reading, as the person who docked it: they see the party.
function docked() {
  return partyState({
    isHost: true,
    memberId: "me",
    members: [
      partyMember({ id: "me", name: "Kevin", host: true, you: true }),
      partyMember({ id: "ana", name: "Ana", status: "loading" }),
    ],
  });
}

beforeEach(() => {
  store.device = deviceSettings({ partyDock: true });
  store.saves = [];
  vi.mocked(Store.SaveDeviceSettings).mockClear();
  // src/test/setup.ts's stand-ins, overridden: in a party, with no messages.
  vi.mocked(Party.State).mockResolvedValue(docked());
  vi.mocked(Party.Chat).mockResolvedValue({ messages: [], unread: 0 });
});

describe("PartyDock", () => {
  it("is a sidebar with the party's people and its chat", async () => {
    renderDock();

    const dock = screen.getByRole("complementary", { name: "Watch party" });
    expect(dock).toHaveAttribute("data-slot", "party-dock");
    // No backdrop of its own: the video stays usable beside it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const people = await within(dock).findByRole("region", { name: "People" });
    expect(within(people).getByText("Kevin")).toBeInTheDocument();
    expect(within(people).getByText("Ana")).toBeInTheDocument();
    expect(within(dock).getByRole("log", { name: "Chat" })).toBeInTheDocument();
    expect(within(dock).getByText("No messages yet")).toBeInTheDocument();
  });

  it("undocks, leaving the party open", async () => {
    renderDock();
    const user = userEvent.setup();
    // The setting is the device's: loaded before there is anything to save.
    await screen.findByRole("region", { name: "People" });

    await user.click(screen.getByRole("button", { name: "Undock" }));

    await waitFor(() =>
      expect(Store.SaveDeviceSettings).toHaveBeenCalledWith(
        expect.objectContaining({ partyDock: false }),
      ),
    );
    // The rest of the device's settings go with it, as the other toggles do.
    expect(store.saves.at(-1)).toMatchObject(deviceSettings({ partyDock: false }));
  });

  it("closes the panel, keeping the setting", async () => {
    const onClose = renderDock();
    const user = userEvent.setup();
    await screen.findByRole("region", { name: "People" });

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledOnce();
    // The dock is still the device's choice; player-page just hides it.
    expect(store.saves).toEqual([]);
    expect(store.device?.partyDock).toBe(true);
  });
});
