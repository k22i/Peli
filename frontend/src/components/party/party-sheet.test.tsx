import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Media, State } from "@bindings/party";
import { Service as Party } from "@bindings/party";
import type { DeviceSettings } from "@bindings/store";
import { sheetsOpen } from "@/lib/sheets";
import { deviceSettings, partyMember, partyState } from "@/test/fixtures";
import { onCompactIOS } from "@/test/ios";

import { PartySheet } from "./party-sheet";

// The tabs tick the Taptic engine on iOS (#135); a no-op here.
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn<(kind: string) => void>() }));

// The device's settings, where the dock's choice lives (ADR-0051), and the
// saves made onto them.
const device = vi.hoisted(() => ({
  settings: undefined as DeviceSettings | undefined,
  saves: [] as DeviceSettings[],
}));

vi.mock("@bindings/store", () => ({
  Service: {
    DeviceSettings: () => Promise.resolve(device.settings),
    SaveDeviceSettings: (settings: DeviceSettings) => {
      device.saves.push(settings);
      device.settings = settings;
      return Promise.resolve();
    },
  },
}));

// What's playing, as the player's sheet is given it.
const media: Media = {
  type: "movie",
  id: "tt0111161",
  videoId: "",
  season: null,
  episode: null,
  title: "The Shawshank Redemption",
  episodeTitle: "",
  description: "",
  poster: "",
  background: "",
  logo: "",
  source: null,
};

function renderSheet(state?: State) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <QueryClientProvider client={client}>
      <PartySheet open onOpenChange={onOpenChange} state={state} media={media} canShare={false} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

// In a party: the host's, with themselves and one member still loading.
function hosted(): State {
  return partyState({
    isHost: true,
    memberId: "me",
    members: [
      partyMember({ id: "me", name: "Kevin", host: true, you: true }),
      partyMember({ id: "ana", name: "Ana", status: "loading" }),
    ],
  });
}

let restore: (() => void) | undefined;

beforeEach(() => {
  // src/test/setup.ts's stand-ins for the service: not in a party, no chat,
  // and a code that joins nothing until a test says otherwise.
  vi.mocked(Party.State).mockResolvedValue({ unavailable: "", busy: false, party: null });
  vi.mocked(Party.Chat).mockResolvedValue({ messages: [], unread: 0 });
  vi.mocked(Party.Preview).mockResolvedValue({
    error: "party_not_found",
    media: null,
    host: "",
    members: 0,
    maxMembers: 0,
  });
  // This device's settings, not docked, and no save made yet.
  device.settings = deviceSettings();
  device.saves = [];
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("PartySheet", () => {
  it("is a bottom sheet from the edge on an iPhone (ADR-0063)", async () => {
    restore = onCompactIOS();
    const onOpenChange = renderSheet();
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    expect(sheet).toHaveAttribute("data-slot", "bottom-sheet");
    // Base UI doesn't set aria-modal; the sheet sets it by hand.
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(within(sheet).getByText(/Invite friends on Peli or Nuvio/)).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "Party code" })).toBeInTheDocument();
    // The tab bar hides while it is up (#129).
    expect(sheetsOpen()).toBe(1);

    await user.keyboard("{Escape}");
    // Base UI passes the trigger's event details as a second argument.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything()));
  });

  it("is the side sheet it always was on a desktop window", async () => {
    renderSheet();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    expect(sheet).toHaveAttribute("data-slot", "sheet-popup");
    expect(sheet).not.toHaveAttribute("aria-modal");
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeInTheDocument();
    // No tab bar of its own to hide, and this isn't a BottomSheet.
    expect(sheetsOpen()).toBe(0);
  });

  it("starts one for what plays", async () => {
    renderSheet();
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    await user.click(within(sheet).getByRole("button", { name: "Start a watch party" }));

    expect(Party.Create).toHaveBeenCalledExactlyOnceWith(media);
  });

  it("shows what a friend's code joins, and joins it", async () => {
    vi.mocked(Party.Preview).mockResolvedValue({
      error: "",
      media,
      host: "Ana",
      members: 3,
      maxMembers: 8,
    });
    const onOpenChange = renderSheet();
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    await user.type(within(sheet).getByRole("textbox", { name: "Party code" }), "abcdef");

    // The code is read as six characters, upper case, and asked about whole.
    expect(await within(sheet).findByText("The Shawshank Redemption")).toBeInTheDocument();
    expect(within(sheet).getByText(/Hosted by Ana/)).toHaveTextContent("3 of 8 seats");
    expect(Party.Preview).toHaveBeenCalledWith("ABCDEF");

    await user.click(within(sheet).getByRole("button", { name: "Join" }));
    expect(Party.Join).toHaveBeenCalledExactlyOnceWith("ABCDEF");
    // A party joined from the player's sheet closes it.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("says why a code joins nothing, and won't join it", async () => {
    renderSheet();
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    await user.type(within(sheet).getByRole("textbox", { name: "Party code" }), "ZZZZZZ");

    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "No watch party has that code.",
    );
    expect(within(sheet).getByRole("button", { name: "Join" })).toBeDisabled();
    expect(Party.Join).not.toHaveBeenCalled();
  });

  it("shows the code and the people in the party, and the host's controls", async () => {
    const state = hosted();
    vi.mocked(Party.State).mockResolvedValue(state);
    renderSheet(state);
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    // The code is spelled out for VoiceOver, and reads as one code.
    expect(await within(sheet).findByLabelText("Party code A B C D E F")).toHaveTextContent(
      "ABC DEF",
    );

    const people = within(sheet).getByRole("region", { name: "People" });
    expect(within(people).getByText("2 of 8 seats")).toBeInTheDocument();
    expect(within(people).getByText("Kevin")).toBeInTheDocument();
    expect(within(people).getByText("Ana")).toBeInTheDocument();
    expect(within(people).getByText("Watching")).toBeInTheDocument();
    expect(within(people).getByText("Loading")).toBeInTheDocument();
    // The host can remove others, never themselves.
    expect(within(people).getByRole("button", { name: "Remove Ana" })).toBeInTheDocument();
    expect(within(people).queryByRole("button", { name: "Remove Kevin" })).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole("switch", { name: /Only I can control playback/ }));
    expect(Party.SetHostOnly).toHaveBeenCalledWith(true);
  });

  it("sends a chat message", async () => {
    const state = partyState({ memberId: "me" });
    vi.mocked(Party.State).mockResolvedValue(state);
    vi.mocked(Party.Chat).mockResolvedValue({
      messages: [
        {
          key: "m1",
          memberId: "ana",
          name: "Ana",
          avatarUrl: "",
          avatarColor: "",
          body: "Ready when you are",
          sentAt: 0,
          mine: false,
          status: "sent",
        },
      ],
      unread: 1,
    });
    renderSheet(state);
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    // The unread count rides on the tab's name.
    await user.click(within(sheet).getByRole("tab", { name: /^Chat/ }));

    const log = await within(sheet).findByRole("log", { name: "Chat" });
    expect(await within(log).findByText("Ready when you are")).toBeInTheDocument();
    // Open in the sheet, so nothing counts as unread.
    expect(Party.SetChatOpen).toHaveBeenCalledWith(true);

    await user.type(within(sheet).getByRole("textbox", { name: "Message" }), "Hello Ana");
    await user.click(within(sheet).getByRole("button", { name: "Send" }));

    expect(Party.SendMessage).toHaveBeenCalledExactlyOnceWith("Hello Ana");
    await waitFor(() =>
      expect(within(sheet).getByRole("textbox", { name: "Message" })).toHaveValue(""),
    );
  });

  it("keeps the party open beside the video, from its header", async () => {
    const state = hosted();
    vi.mocked(Party.State).mockResolvedValue(state);
    renderSheet(state);
    const user = userEvent.setup();

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    const keepOpen = within(sheet).getByRole("button", { name: "Keep open beside the video" });
    // A toggle in appearance, and off until it is pressed: the dock is what
    // it turns on, and the player then shows it in place of this sheet.
    expect(keepOpen).toHaveAttribute("aria-pressed", "false");

    await user.click(keepOpen);

    await waitFor(() => expect(device.saves.at(-1)).toMatchObject({ partyDock: true }));
    // The party is still theirs: the sheet doesn't close the party, and
    // player-page closes the sheet when the dock takes over.
    expect(Party.Leave).not.toHaveBeenCalled();
  });

  it("has no dock to offer on an iPhone (ADR-0063)", async () => {
    restore = onCompactIOS();
    const state = hosted();
    vi.mocked(Party.State).mockResolvedValue(state);
    renderSheet(state);

    const sheet = await screen.findByRole("dialog", { name: "Watch party" });
    expect(
      within(sheet).queryByRole("button", { name: "Keep open beside the video" }),
    ).not.toBeInTheDocument();
  });
});
