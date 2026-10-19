import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";

import type { Status } from "@bindings/account";
import type { Profile } from "@bindings/store";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

// Stand-ins for the Go store and account services, and the Wails events Go
// sends.
const backend = vi.hoisted(() => ({
  profiles: [] as Profile[],
  current: undefined as Profile | undefined,
  status: { signedIn: false, sessionEnded: false } as Status,
  signOuts: 0,
  signOutError: undefined as string | undefined,
  events: new Map<string, () => void>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: () => void) => {
        backend.events.set(name, callback);
        return () => backend.events.delete(name);
      },
    },
  };
});

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => backend.profiles,
    CurrentProfile: async () => backend.current ?? backend.profiles[0],
    ProfileSettings: async () => ({
      audioLanguage: "",
      subtitleLanguage: "",
      subtitleSize: "medium",
      captions: "system",
    }),
    DeviceSettings: async () => ({ hardwareDecoding: true, diagnostics: false }),
    Addons: async () => [],
  },
}));

vi.mock("@bindings/secrets", () => ({ Service: { Available: async () => {} } }));

vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => backend.status,
    // As internal/account does: the Nuvio profiles go, local ones stay.
    SignOut: async () => {
      backend.signOuts++;
      if (backend.signOutError) throw new Error(backend.signOutError);
      backend.profiles = backend.profiles.filter((p) => p.nuvioIndex == null);
      backend.current = undefined;
      backend.status = { signedIn: false, sessionEnded: false };
    },
  },
}));

const guest: Profile = { id: 1, name: "Guest" };
const kevin: Profile = { id: 2, name: "Kevin", nuvioIndex: 1 };

function signedIn(...profiles: Profile[]) {
  backend.profiles = profiles;
  backend.current = kevin;
  backend.status = { signedIn: true, sessionEnded: false };
}

beforeEach(() => {
  backend.profiles = [];
  backend.current = undefined;
  backend.status = { signedIn: false, sessionEnded: false };
  backend.signOuts = 0;
  backend.signOutError = undefined;
  backend.events.clear();
});

async function openSignOut(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Profile: Kevin" }));
  await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  return screen.findByRole("alertdialog", { name: "Sign out of Nuvio?" });
}

describe("restore", () => {
  it("opens signed in, with no sign-in screen", async () => {
    signedIn(kevin);
    const { router } = await renderApp("/settings");

    expect(router.state.location.pathname).toBe("/settings");
    expect(await screen.findByText("Synced with Nuvio")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

describe("sign out", () => {
  it("asks first, then signs out to the welcome screen", async () => {
    signedIn(kevin);
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    const dialog = await openSignOut(user);
    expect(dialog).toHaveTextContent("Anything not yet synced to Nuvio is lost");
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
    expect(backend.signOuts).toBe(1);
    expect(await screen.findByText("Signed out of Nuvio")).toBeInTheDocument();
  });

  it("lands on the guest's profile when there is one", async () => {
    signedIn(guest, kevin);
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    const dialog = await openSignOut(user);
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Profile: Guest" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  it("does nothing on Cancel", async () => {
    signedIn(kevin);
    const user = userEvent.setup();
    await renderApp("/");

    const dialog = await openSignOut(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(backend.signOuts).toBe(0);
    expect(screen.getByRole("button", { name: "Profile: Kevin" })).toBeVisible();
  });

  it("says when it fails and stays signed in", async () => {
    signedIn(kevin);
    backend.signOutError = "keychain: delete failed";
    const user = userEvent.setup();
    const { router } = await renderApp("/settings");

    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Couldn’t sign out")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("isn't offered to a guest", async () => {
    backend.profiles = [guest];
    const user = userEvent.setup();
    await renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Profile: Guest" }));
    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("session ended", () => {
  it("offers to sign in again at launch, and Not now keeps the data", async () => {
    backend.profiles = [kevin];
    backend.status = { signedIn: false, sessionEnded: true };
    const user = userEvent.setup();
    const { router } = await renderApp("/", { shell: false });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Your Nuvio session ended");
    expect(notice).toHaveTextContent("Your library and progress on this computer are kept");
    expect(router.state.location.pathname).toBe("/sign-in");

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");

    // Settings says so, and offers both ways out. No second redirect.
    await act(() => router.navigate({ to: "/settings" }));
    expect(await screen.findByText("Nuvio session ended, kept on this device")).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("goes to sign-in when Go finds the session ended", async () => {
    signedIn(kevin);
    const { router } = await renderApp("/settings");
    await screen.findByText("Synced with Nuvio");

    backend.status = { signedIn: false, sessionEnded: true };
    act(() => backend.events.get("account:session-ended")?.());

    expect(await screen.findByRole("alert")).toHaveTextContent("Your Nuvio session ended");
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ reason: "session-ended" });
  });
});
