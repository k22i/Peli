import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Profile } from "@bindings/store";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

// Stand-ins for the Go store, keychain and account services.
const backend = vi.hoisted(() => ({
  profiles: [] as Profile[],
  current: undefined as Profile | undefined,
  keychain: null as string | null,
  // What SignIn fails with: an error code from internal/account, or a plain
  // message.
  failWith: undefined as { code?: string | undefined; message: string } | undefined,
  signIns: [] as { email: string; password: string }[],
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => backend.profiles,
    CurrentProfile: async () => {
      if (!backend.current) {
        backend.current = { id: 1, name: "Guest", guest: true };
        backend.profiles = [backend.current];
      }
      return backend.current;
    },
    SwitchToGuest: async () => {
      backend.current = backend.profiles.find((p) => p.guest);
      if (!backend.current) {
        backend.current = { id: backend.profiles.length + 1, name: "Guest", guest: true };
        backend.profiles = [...backend.profiles, backend.current];
      }
      return backend.current;
    },
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

vi.mock("@bindings/secrets", () => ({
  Service: {
    Available: async () => {
      if (backend.keychain) throw new Error(backend.keychain);
    },
  },
}));

vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => ({ signedIn: backend.current?.nuvioIndex != null, sessionEnded: false }),
    SignIn: async (email: string, password: string) => {
      backend.signIns.push({ email, password });
      const failure = backend.failWith;
      if (failure) {
        throw new Error(failure.message, failure.code ? { cause: { code: failure.code } } : {});
      }
      const kevin: Profile = { id: 2, name: "Kevin", nuvioIndex: 1 };
      backend.profiles = [...backend.profiles, kevin];
      backend.current = kevin;
      return kevin;
    },
  },
}));

beforeEach(() => {
  backend.profiles = [];
  backend.current = undefined;
  backend.keychain = null;
  backend.failWith = undefined;
  backend.signIns = [];
});

async function renderFirstRun() {
  const app = await renderApp("/", { shell: false });
  await screen.findByRole("heading", { level: 1, name: "Sinag" });
  return app;
}

async function fillIn(user: ReturnType<typeof userEvent.setup>, password = "correct horse") {
  await user.type(screen.getByRole("textbox", { name: "Email" }), "me@example.com");
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("first run", () => {
  it("starts at the welcome screen with sign in, QR (later) and guest", async () => {
    const { router } = await renderFirstRun();

    expect(router.state.location.pathname).toBe("/welcome");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in with email" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Scan a QR code/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue as guest" })).toBeEnabled();
  });

  it("continues as a guest into the app", async () => {
    const user = userEvent.setup();
    const { router } = await renderFirstRun();

    await user.click(screen.getByRole("button", { name: "Continue as guest" }));

    expect(await screen.findByRole("navigation", { name: "Main" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(backend.profiles).toEqual([{ id: 1, name: "Guest", guest: true }]);
    expect(screen.getByRole("button", { name: "Profile: Guest" })).toBeVisible();
  });

  it("explains a missing keychain and still allows guests", async () => {
    backend.keychain =
      "secrets: no Secret Service found: install and start gnome-keyring or KWallet";
    await renderFirstRun();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Signing in needs a keychain");
    expect(alert).toHaveTextContent("gnome-keyring");
    expect(screen.queryByRole("link", { name: "Sign in with email" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with email" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue as guest" })).toBeEnabled();
  });

  it("doesn't come back once there is a profile", async () => {
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    const { router } = await renderApp("/");
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("sign in", () => {
  it("signs in and lands on Home with the Nuvio profile", async () => {
    const user = userEvent.setup();
    const { router } = await renderFirstRun();

    await user.click(screen.getByRole("link", { name: "Sign in with email" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });
    await fillIn(user);

    expect(await screen.findByRole("navigation", { name: "Main" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(backend.signIns).toEqual([{ email: "me@example.com", password: "correct horse" }]);
    expect(await screen.findByText("Signed in as Kevin")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
  });

  it("asks for both fields before calling Nuvio", async () => {
    const user = userEvent.setup();
    await renderApp("/sign-in", { shell: false });

    await user.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("textbox", { name: "Email" })).toBeInvalid();
    expect(backend.signIns).toEqual([]);
  });

  it("shows a wrong password under the password field", async () => {
    backend.failWith = { code: "invalid_credentials", message: "nuvio: wrong email or password" };
    const user = userEvent.setup();
    const { router } = await renderApp("/sign-in", { shell: false });
    await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });

    await fillIn(user, "wrong");

    expect(
      await screen.findByText("That email and password don’t match a Nuvio account."),
    ).toBeVisible();
    expect(screen.getByLabelText("Password")).toBeInvalid();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it.each([
    ["unreachable", "Can’t reach Nuvio", "Check your internet connection"],
    ["unavailable", "Nuvio isn’t responding", "Try again in a minute"],
    ["keychain_unavailable", "Signing in needs a keychain", "nuvio: the message from Go"],
    [undefined, "Couldn’t sign in", "nuvio: the message from Go"],
  ])("explains %s", async (code, title, description) => {
    backend.failWith = { code, message: "nuvio: the message from Go" };
    const user = userEvent.setup();
    await renderApp("/sign-in", { shell: false });
    await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });

    await fillIn(user);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(title)).toBeVisible();
    expect(alert).toHaveTextContent(description);
    // Trying again is the same button.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("waits before letting a rate-limited user try again", async () => {
    backend.failWith = { code: "rate_limited", message: "nuvio: too many requests" };
    // Only setTimeout: React's scheduler needs the real setImmediate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      await renderApp("/sign-in", { shell: false });
      await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });

      await fillIn(user);

      expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
      expect(screen.getByRole("button", { name: "Try again in 10 s" })).toBeDisabled();
      // One second at a time: each tick renders and arms the next.
      for (let second = 0; second < 10; second++) {
        // oxlint-disable-next-line no-await-in-loop -- the ticks are sequential
        await act(() => vi.advanceTimersByTimeAsync(1000));
      }
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is reached from Settings by a guest, and Back returns there", async () => {
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    backend.current = backend.profiles[0];
    const user = userEvent.setup();
    const { router } = await renderApp("/settings");

    await user.click(await screen.findByRole("link", { name: "Sign in" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });

  it("is offered to a guest in the profile menu, keeping the Guest apart", async () => {
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    backend.current = backend.profiles[0];
    const user = userEvent.setup();
    await renderApp("/");

    await user.click(screen.getByRole("button", { name: "Profile: Guest" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "Sign in to Nuvio" }));

    await screen.findByRole("heading", { level: 1, name: "Sign in to Nuvio" });
    expect(screen.getByText(/Your Guest profile stays on this computer/)).toBeVisible();
    await fillIn(user);

    // Two profiles now, so the picker asks which, with Kevin first in line.
    await screen.findByRole("heading", { level: 1, name: "Who’s watching?" });
    expect(await screen.findByText("Signed in to Nuvio")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Kevin" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
    // Nothing merged: the Guest is still there, as it was.
    expect(backend.profiles).toEqual([
      { id: 1, name: "Guest", guest: true },
      { id: 2, name: "Kevin", nuvioIndex: 1 },
    ]);
  });
});
