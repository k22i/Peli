import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Status } from "@bindings/account";
import type { Addon, Profile, ProfileSettings } from "@bindings/store";
import { initialsColor } from "@/components/account/profile-avatar";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

// An in-memory stand-in for the Go store: each profile has its own settings
// and addons, as in internal/store.
const backend = vi.hoisted(() => ({
  profiles: [] as Profile[],
  current: 0,
  status: { signedIn: false, sessionEnded: false } as Status,
  settings: new Map<number, Partial<ProfileSettings>>(),
  addons: new Map<number, Addon[]>(),
  switches: [] as number[],
  failSwitch: false,
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => backend.profiles,
    CurrentProfile: async () =>
      backend.profiles.find((p) => p.id === backend.current) ?? backend.profiles[0],
    SetCurrentProfile: async (id: number) => {
      if (backend.failSwitch) throw new Error("disk full");
      backend.switches.push(id);
      backend.current = id;
    },
    // As Go does: if it was current, the oldest one left takes over.
    DeleteProfile: async (id: number) => {
      backend.profiles = backend.profiles.filter((p) => p.id !== id);
      if (backend.current === id) backend.current = backend.profiles[0]?.id ?? 0;
    },
    ProfileSettings: async (id: number) => ({
      audioLanguage: "",
      subtitleLanguage: "",
      subtitleSize: "medium",
      captions: "system",
      ...backend.settings.get(id),
    }),
    DeviceSettings: async () => ({ hardwareDecoding: true, diagnostics: false }),
    Addons: async (id: number) => backend.addons.get(id) ?? [],
  },
}));

vi.mock("@bindings/secrets", () => ({ Service: { Available: async () => {} } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: async () => backend.status },
}));

const guest: Profile = { id: 1, name: "Guest", guest: true };
const kevin: Profile = {
  id: 2,
  name: "Kevin",
  nuvioIndex: 1,
  avatar: "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/otto-v1.png",
  avatarColor: "#0BB5AE",
};
const kids: Profile = { id: 3, name: "Kids Room", nuvioIndex: 3, avatarColor: "#7957BD" };
const cinemeta: Addon = { url: "https://cinemeta/manifest.json", enabled: true };
const anime: Addon = { url: "https://anime/manifest.json", enabled: true };

function signedIn(current: Profile, ...profiles: Profile[]) {
  backend.profiles = profiles;
  backend.current = current.id;
  backend.status = { signedIn: true, sessionEnded: false };
}

beforeEach(() => {
  backend.profiles = [];
  backend.current = 0;
  backend.status = { signedIn: false, sessionEnded: false };
  backend.settings.clear();
  backend.addons.clear();
  backend.switches = [];
  backend.failSwitch = false;
});

const picker = () => screen.findByRole("heading", { level: 1, name: "Who’s watching?" });
const size = () => within(screen.getByRole("group", { name: "Size" }));

// A profile's tile, by its name.
const tile = (name: string) => screen.findByRole("button", { name });

describe("profile picker", () => {
  it("asks who's watching at launch, with the last profile used first in line", async () => {
    signedIn(kids, guest, kevin, kids);
    const user = userEvent.setup();
    const { router } = await renderApp("/", { shell: false });

    await picker();
    expect(router.state.location.pathname).toBe("/profiles");
    const list = screen.getByRole("list", { name: "Profiles" });
    await within(list).findByRole("button", { name: "Kevin" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => [b.getAttribute("aria-label"), b.textContent]),
    ).toEqual([
      ["Guest", expect.stringMatching(/GuestOn this computer$/)],
      ["Kevin", expect.stringMatching(/Kevin$/)],
      ["Kids Room", expect.stringMatching(/Kids RoomLast used$/)],
    ]);
    expect(await tile("Kids Room")).toHaveAccessibleDescription("Last used");
    // Return picks the remembered profile.
    expect(await tile("Kids Room")).toHaveFocus();
    expect(await tile("Kids Room")).toHaveAttribute("aria-current", "true");
    // At launch, picking is the only way in.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    await user.click(await tile("Kevin"));
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(backend.switches).toEqual([kevin.id]);
  });

  it("goes straight in with one profile", async () => {
    signedIn(kevin, kevin);
    const { router } = await renderApp("/");

    expect(router.state.location.pathname).toBe("/");
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
  });

  it("shows avatars on their colour, with initials until the image loads", async () => {
    signedIn(kevin, kevin, kids);
    await renderApp("/", { shell: false });
    await picker();

    // jsdom never loads images, so this is also what shows offline.
    const kevinAvatar = (await tile("Kevin")).querySelector("[data-slot=avatar]");
    expect(kevinAvatar).toHaveStyle({ backgroundColor: "#0BB5AE" });
    expect(await within(await tile("Kevin")).findByText("K")).toBeVisible();
    expect(within(await tile("Kids Room")).getByText("KR")).toBeVisible();
  });

  it("says when switching fails and stays put", async () => {
    signedIn(kevin, kevin, kids);
    backend.failSwitch = true;
    const user = userEvent.setup();
    const { router } = await renderApp("/", { shell: false });
    await picker();

    await user.click(await tile("Kids Room"));

    expect(await screen.findByText("Couldn’t switch to Kids Room")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/profiles");
  });

  it("removes the Guest after asking, keeping the account's profiles", async () => {
    signedIn(guest, guest, kevin);
    const user = userEvent.setup();
    const { router } = await renderApp("/", { shell: false });
    await picker();

    await user.click(screen.getByRole("button", { name: "Remove the Guest profile" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Guest?" });
    expect(dialog).toHaveTextContent("can’t be brought back");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Removed Guest")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Guest" })).toBeNull());
    expect(backend.profiles).toEqual([kevin]);
    // Kevin took over as current, and is a press of Return away.
    await user.click(await tile("Kevin"));
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  it("doesn't offer to remove a Guest that is the only profile", async () => {
    backend.profiles = [guest];
    backend.current = guest.id;
    const user = userEvent.setup();
    await renderApp("/");

    // From the keyboard: the submenu opens with the right arrow.
    (await screen.findByRole("button", { name: "Profile: Guest" })).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Switch profile" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "Guest" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Manage profiles" })).toHaveFocus();
    await user.keyboard("{Enter}");

    await picker();
    expect(screen.queryByRole("button", { name: "Remove the Guest profile" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Sign in to bring your Nuvio profiles" }),
    ).toBeVisible();
    // Opened from the app, so there's a way back.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Profile: Guest" })).toBeVisible();
  });
});

describe("switching from the profile menu", () => {
  it("swaps the profile's settings and addons in place, without a restart", async () => {
    signedIn(kevin, kevin, kids);
    backend.settings.set(kids.id, { subtitleSize: "large" });
    backend.addons.set(kevin.id, [cinemeta]);
    backend.addons.set(kids.id, [cinemeta, anime]);
    const user = userEvent.setup();
    // Past the launch picker, as after picking Kevin.
    const { router } = await renderApp("/profiles", { shell: false });
    await user.click(await tile("Kevin"));
    await screen.findByRole("button", { name: "Profile: Kevin" });
    await router.navigate({ to: "/settings" });

    expect(await screen.findByText("1 addon installed")).toBeVisible();
    expect(size().getByRole("button", { name: "Medium" })).toHaveAttribute("aria-pressed", "true");

    screen.getByRole("button", { name: "Profile: Kevin" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Switch profile" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "Kevin" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Kids Room" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: "Profile: Kids Room" })).toBeVisible();
    expect(await screen.findByText("2 addons installed")).toBeVisible();
    await waitFor(() =>
      expect(size().getByRole("button", { name: "Large" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(router.state.location.pathname).toBe("/settings");
    // Kevin was already current, so picking him switched nothing.
    expect(backend.switches).toEqual([kids.id]);
  });

  it("offers Sign out on the Guest while an account is signed in beside it", async () => {
    signedIn(guest, guest);
    backend.profiles = [guest, kevin];
    const user = userEvent.setup();
    const { router } = await renderApp("/profiles", { shell: false });
    await user.click(await tile("Guest"));
    await router.navigate({ to: "/settings" });

    // The Guest itself never syncs (ADR-0010)…
    expect(await screen.findByText("Local profile, kept on this device")).toBeVisible();
    // …but the account is signed in, so there's nothing to sign in to.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Profile: Guest" }));
    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Sign in to Nuvio" })).toBeNull();
  });
});

describe("initials colour", () => {
  it("picks whichever of black and white reads better", () => {
    expect(initialsColor("#33B5E0")).toBe("#0A0A0A");
    expect(initialsColor("#7957BD")).toBe("#FFFFFF");
    expect(initialsColor("#B9E53A")).toBe("#0A0A0A");
  });
});
