import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type AccountParty, Service as Party } from "@bindings/party";
import { accountParty } from "@/test/fixtures";

import { AccountParties } from "./account-parties";

// The account's live parties on the Join page (ADR-0067): another profile of
// the account hosts one, and it joins in one click with no code. The
// bindings are src/test/setup.ts's stand-ins, given parties here.
function renderList(parties: AccountParty[]) {
  vi.mocked(Party.AccountParties).mockResolvedValue(parties);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AccountParties />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(Party.Join).mockClear();
  vi.mocked(Party.Join).mockResolvedValue(undefined);
});

describe("AccountParties", () => {
  it("says so when nobody is watching together", async () => {
    renderList([]);
    expect(await screen.findByText(/No one on this account is watching together/)).toBeTruthy();
  });

  it("lists the party with what's playing, who hosts it and its seats", async () => {
    renderList([accountParty()]);
    expect(await screen.findByText("The Shawshank Redemption")).toBeTruthy();
    expect(screen.getByText(/Hosted by Kevin/)).toBeTruthy();
    expect(screen.getByText(/1 of 8 seats/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Parties on this account" })).toBeTruthy();
  });

  it("joins it with the code, no typing", async () => {
    renderList([accountParty({ code: "GHJKLM" })]);
    const join = await screen.findByRole("button", { name: /Join/ });
    await userEvent.click(join);
    await waitFor(() => expect(Party.Join).toHaveBeenCalledWith("GHJKLM"));
  });

  it("doesn't offer a full party", async () => {
    renderList([accountParty({ members: 8, maxMembers: 8 })]);
    expect(await screen.findByRole("button", { name: /Full/ })).toBeDisabled();
  });
});
