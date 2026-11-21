import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Reaction } from "@bindings/party";
import type * as Runtime from "@wailsio/runtime";

import { REACTIONS, reactionEvent, reactionName } from "@/lib/party";
import { partyState } from "@/test/fixtures";

import { PartyReactionLayer, ReactionBar } from "./reaction-bar";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { data: unknown }) => void>>(),
  state: vi.fn<() => Promise<unknown>>(),
  sendReaction: vi.fn<(emoji: string) => Promise<void>>(),
  burst: vi.fn<(emoji: string) => void>(),
  haptic: vi.fn<(kind: string) => void>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        const callbacks: Set<(event: { data: unknown }) => void> =
          mocks.listeners.get(name) ?? new Set();
        callbacks.add(callback);
        mocks.listeners.set(name, callbacks);
        return () => void callbacks.delete(callback);
      },
    },
  };
});

// The party service, by hand: the state the bar reads and the call it makes.
vi.mock("@bindings/party", () => ({
  Service: {
    State: mocks.state,
    Chat: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ messages: [], unread: 0 })),
    SendReaction: mocks.sendReaction,
  },
}));

// The confetti (its physics lives in lib/confetti): here it only has to be
// called, and to be on screen.
vi.mock("@/components/party/emoji-confetti", () => ({
  EmojiConfetti: () => <div data-testid="confetti" />,
  burst: mocks.burst,
}));

// A light tap on iOS (#135); a no-op in jsdom.
vi.mock("@/lib/haptics", () => ({ haptic: mocks.haptic }));

// Ana's fire, or another member's emoji; `mine` is the sender's own echo.
function reaction(changes: Partial<Reaction> = {}): Reaction {
  return { emoji: "🔥", memberId: "ana", name: "Ana", mine: false, at: 1_000, ...changes };
}

function emit(name: string, data: unknown) {
  act(() => {
    for (const callback of mocks.listeners.get(name) ?? []) callback({ data });
  });
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.listeners.clear();
  mocks.state.mockResolvedValue(partyState());
  mocks.sendReaction.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReactionBar", () => {
  it("shows the eight emoji, each with a name of its own", async () => {
    render(<ReactionBar />, { wrapper: wrapper() });

    const bar = await screen.findByRole("group", { name: "Reactions" });
    expect(within(bar).getAllByRole("button")).toHaveLength(REACTIONS.length);
    // In REACTIONS' order, the way Go's list reads.
    expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual([
      ...REACTIONS,
    ]);
    for (const emoji of REACTIONS) {
      const button = screen.getByRole("button", { name: `React with ${reactionName[emoji]}` });
      expect(button).toHaveAttribute("title", `React with ${reactionName[emoji]}`);
    }
  });

  it("sends the emoji a member taps, with a light haptic", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ReactionBar />
        <PartyReactionLayer />
      </>,
      { wrapper: wrapper() },
    );

    const fire = await screen.findByRole("button", { name: "React with fire" });
    await waitFor(() => expect(fire).toBeEnabled());
    await user.click(fire);

    expect(mocks.sendReaction).toHaveBeenCalledWith("🔥");
    expect(mocks.haptic).toHaveBeenCalledWith("light");
    // Nothing bursts on the tap: Go's echo of its own reaction does that, so
    // the sender sees what everyone else does.
    expect(mocks.burst).not.toHaveBeenCalled();
  });

  it("is off outside a party", async () => {
    mocks.state.mockResolvedValue({ unavailable: "", busy: false, party: null });
    render(<ReactionBar />, { wrapper: wrapper() });

    // Go has answered: there is no party to react in.
    await waitFor(() => expect(mocks.state).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "React with fire" })).toBeDisabled();
  });

  it("is off while the party's channel reconnects", async () => {
    mocks.state.mockResolvedValue(partyState({ connected: false }));
    render(<ReactionBar />, { wrapper: wrapper() });

    await waitFor(() => expect(mocks.state).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "React with fire" })).toBeDisabled();
  });
});

describe("PartyReactionLayer", () => {
  it("bursts the emoji of each reaction that arrives", () => {
    render(<PartyReactionLayer />);
    expect(screen.getByTestId("confetti")).toBeInTheDocument();

    emit(reactionEvent, reaction());

    expect(mocks.burst).toHaveBeenCalledWith("🔥");
  });

  it("names someone else's reaction, the newer one replacing the older", () => {
    render(<PartyReactionLayer />);

    emit(reactionEvent, reaction());
    const first = screen.getByText("Ana 🔥");
    expect(first.parentElement).toHaveAttribute("aria-hidden");

    emit(reactionEvent, reaction({ memberId: "bo", name: "Bo", emoji: "🎉", at: 2_000 }));
    expect(screen.getByText("Bo 🎉")).toBeInTheDocument();
    expect(screen.queryByText("Ana 🔥")).not.toBeInTheDocument();
  });

  it("says nothing for your own reaction", () => {
    render(<PartyReactionLayer />);

    emit(reactionEvent, reaction({ mine: true }));

    // It still bursts: the sender sees their own emoji as the others do.
    expect(mocks.burst).toHaveBeenCalledWith("🔥");
    expect(screen.queryByText("Ana 🔥")).not.toBeInTheDocument();
  });

  it("lets the line go after a moment", () => {
    vi.useFakeTimers();
    render(<PartyReactionLayer />);

    emit(reactionEvent, reaction());
    expect(screen.getByText("Ana 🔥")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.queryByText("Ana 🔥")).not.toBeInTheDocument();
  });
});
