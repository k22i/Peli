import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => [{ id: 1, name: "Guest", guest: true }],
    CurrentProfile: async () => ({ id: 1, name: "Guest", guest: true }),
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

vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => ({ signedIn: false, sessionEnded: false }),
    Server: async () => ({ url: "https://api.nuvio.tv", custom: false, hasKey: false }),
  },
}));

// The keychain, in memory; `failWith` is what Set rejects with.
const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  failWith: undefined as string | undefined,
}));

vi.mock("@bindings/secrets", () => ({
  Service: {
    Available: async () => {},
    Get: async (key: string) => keychain.items.get(key) ?? null,
    Set: async (key: string, value: string) => {
      if (keychain.failWith) throw new Error(keychain.failWith);
      keychain.items.set(key, value);
    },
    Delete: async (key: string) => void keychain.items.delete(key),
  },
}));

// TMDB, taking only the key "good". The Wails runtime fetches too, with URL
// objects.
function serveTmdb() {
  const fetch = vi.fn<(url: string | URL) => Promise<Response>>(async (url) =>
    new URL(url).searchParams.get("api_key") === "good"
      ? Response.json({ success: true })
      : new Response("{}", { status: 401 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  keychain.items.clear();
  keychain.failWith = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openTmdbDialog(user: ReturnType<typeof userEvent.setup>, name: string) {
  await renderApp("/settings");
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog", { name: "TMDB" });
}

describe("TMDB key", () => {
  it("is optional, and checked with TMDB before it's kept in the keychain", async () => {
    const fetch = serveTmdb();
    const user = userEvent.setup();
    const dialog = await openTmdbDialog(user, "Add TMDB key");
    expect(within(dialog).getByText(/not endorsed or certified by TMDB/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("API key or read access token"), "wrong");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/TMDB refused the key/)).toBeInTheDocument();
    expect(keychain.items.size).toBe(0);

    const field = within(dialog).getByLabelText("API key or read access token");
    await user.clear(field);
    await user.type(field, " good ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "TMDB" })).toBeNull());
    expect(keychain.items.get("tmdb.api-key")).toBe("good");
    expect(
      fetch.mock.calls.map(([url]) => url.toString()).filter((url) => url.includes("themoviedb")),
    ).toEqual([
      "https://api.themoviedb.org/3/authentication?api_key=wrong",
      "https://api.themoviedb.org/3/authentication?api_key=good",
    ]);
    expect(await screen.findByText(/^Title pages show TMDB’s logos/)).toBeInTheDocument();
  });

  it("says when TMDB can't be reached, and saves nothing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
    const user = userEvent.setup();
    const dialog = await openTmdbDialog(user, "Add TMDB key");

    await user.type(within(dialog).getByLabelText("API key or read access token"), "good");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Can’t reach TMDB")).toBeInTheDocument();
    expect(keychain.items.size).toBe(0);
  });

  it("explains a keychain that can't keep it", async () => {
    serveTmdb();
    keychain.failWith = "no Secret Service is running; install and start gnome-keyring or KWallet";
    const user = userEvent.setup();
    const dialog = await openTmdbDialog(user, "Add TMDB key");

    await user.type(within(dialog).getByLabelText("API key or read access token"), "good");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/install and start gnome-keyring/)).toBeInTheDocument();
  });

  it("removes a saved key", async () => {
    keychain.items.set("tmdb.api-key", "good");
    const user = userEvent.setup();
    const dialog = await openTmdbDialog(user, "Change TMDB key");

    await user.click(within(dialog).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(keychain.items.has("tmdb.api-key")).toBe(false));
    expect(await screen.findByRole("button", { name: "Add TMDB key" })).toBeInTheDocument();
  });
});
