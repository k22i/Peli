import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Server } from "@bindings/account";
import type { Profile } from "@bindings/store";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

// Stand-ins for the Go store and account services: signed in to Nuvio.
const backend = vi.hoisted(() => ({
  profiles: [] as Profile[],
  server: { url: "https://api.nuvio.tv", custom: false, hasKey: false } as Server,
  // What TestServer and SetServer fail with: an error code from
  // internal/account.
  failWith: undefined as string | undefined,
  tests: [] as [string, string][],
  switches: [] as [string, string][],
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => backend.profiles,
    CurrentProfile: async () =>
      backend.profiles.find((p) => p.nuvioIndex != null) ??
      backend.profiles[0] ?? { id: 1, name: "Guest", guest: true },
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

function fail() {
  if (backend.failWith) throw new Error("refused", { cause: { code: backend.failWith } });
}

vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => ({
      signedIn: backend.profiles.some((p) => p.nuvioIndex != null),
      sessionEnded: false,
    }),
    Server: async () => backend.server,
    TestServer: async (url: string, key: string) => {
      backend.tests.push([url, key]);
      fail();
    },
    SetServer: async (url: string, key: string) => {
      backend.switches.push([url, key]);
      fail();
      // Switching to another server signs out.
      backend.profiles = backend.profiles.filter((p) => p.guest);
      backend.server = url
        ? { url: url.replace(/\/$/, ""), custom: true, hasKey: key !== "" }
        : { url: "https://api.nuvio.tv", custom: false, hasKey: false };
      return backend.server;
    },
  },
}));

beforeEach(() => {
  backend.profiles = [{ id: 2, name: "Kevin", nuvioIndex: 1 }];
  backend.server = { url: "https://api.nuvio.tv", custom: false, hasKey: false };
  backend.failWith = undefined;
  backend.tests = [];
  backend.switches = [];
});

async function openServerDialog(user: ReturnType<typeof userEvent.setup>) {
  const result = await renderApp("/settings");
  expect(await screen.findByText(/^Nuvio’s server\./)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Change server" }));
  return { ...result, dialog: await screen.findByRole("dialog", { name: "Server" }) };
}

describe("server", () => {
  it("tests a server, then signs out and switches to it", async () => {
    const user = userEvent.setup();
    const { dialog, router } = await openServerDialog(user);
    // On Nuvio's server, there's nothing to switch.
    expect(within(dialog).getByRole("radio", { name: "Nuvio’s server" })).toBeChecked();
    expect(within(dialog).queryByText("Switching signs you out")).toBeNull();

    await user.click(within(dialog).getByRole("radio", { name: "My own server" }));
    await user.type(within(dialog).getByLabelText("Address"), "https://nuvio.example.com/");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));

    expect(await within(dialog).findByText("Connected")).toBeVisible();
    expect(backend.tests).toEqual([["https://nuvio.example.com/", ""]]);
    expect(within(dialog).getByText("Switching signs you out")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Sign out and switch" }));

    expect(await screen.findByText("Using nuvio.example.com")).toBeVisible();
    expect(backend.switches).toEqual([["https://nuvio.example.com/", ""]]);
    // No profiles are left, so the welcome screen, for the new server and
    // without phone sign-in.
    await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
    expect(await screen.findByText(/account on nuvio\.example\.com/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in with email" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign in with your phone" })).toBeNull();
  });

  it("keeps a key the user gives and shows what the server refused", async () => {
    const user = userEvent.setup();
    const { dialog } = await openServerDialog(user);

    await user.click(within(dialog).getByRole("radio", { name: "My own server" }));
    await user.type(within(dialog).getByLabelText("Address"), "http://192.168.1.20:8000");
    await user.type(within(dialog).getByLabelText("Publishable key (optional)"), "sb_wrong");
    backend.failWith = "server_key_refused";
    await user.click(within(dialog).getByRole("button", { name: "Sign out and switch" }));

    // Under the key field, and in the alert that says what to do.
    expect(await within(dialog).findAllByText("The server refused the key")).toHaveLength(2);
    expect(backend.profiles).toHaveLength(1);

    // A corrected key goes through.
    backend.failWith = undefined;
    const key = within(dialog).getByLabelText("Publishable key (optional)");
    await user.clear(key);
    await user.type(key, "sb_right");
    await user.click(within(dialog).getByRole("button", { name: "Sign out and switch" }));
    expect(await screen.findByText("Using 192.168.1.20:8000")).toBeVisible();
    expect(backend.switches.at(-1)).toEqual(["http://192.168.1.20:8000", "sb_right"]);
  });

  it("shows the server in use and goes back to Nuvio's", async () => {
    backend.server = { url: "https://nuvio.example.com", custom: true, hasKey: true };
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    const user = userEvent.setup();
    await renderApp("/settings");

    expect(await screen.findByText("Your own server, nuvio.example.com.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change server" }));
    const dialog = await screen.findByRole("dialog", { name: "Server" });
    expect(within(dialog).getByLabelText("Address")).toHaveValue("https://nuvio.example.com");
    expect(within(dialog).getByText(/A key is saved for this server/)).toBeVisible();

    await user.click(within(dialog).getByRole("radio", { name: "Nuvio’s server" }));
    // Signed out already: nothing to warn about.
    expect(within(dialog).queryByText("Switching signs you out")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Switch" }));

    expect(await screen.findByText("Using Nuvio’s server")).toBeVisible();
    expect(backend.switches).toEqual([["", ""]]);
  });
});
