import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Avatar, ProfileEdit, Status } from "@bindings/account";
import type { Addon, KidsScope, Profile, ProfileSettings } from "@bindings/store";
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
  unlocks: [] as [number, string][],
  wrongPin: false,
  pinRetry: 0,
  // The profile's PIN changes (#25), as internal/account would push them.
  pinSets: [] as [number, string, string][],
  pinClears: [] as [number, string][],
  wrongCurrentPin: false,
  // The code internal/account fails the next profile change with, if any.
  failChange: "",
  edits: [] as [number | "add", ProfileEdit][],
  // Kids profiles (#26): the parent PINs entered, the profiles made kids or
  // not, what each may see, and the times the user signed out.
  approvals: [] as [number, string][],
  kidsSets: [] as [number, boolean][],
  scopes: new Map<number, KidsScope>(),
  scopeSaves: [] as KidsScope[],
  signOuts: 0,
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
    ProfileSettings: async (id: number) => ({
      audioLanguage: "",
      subtitleLanguage: "",
      subtitleSize: "medium",
      captions: "system",
      ...backend.settings.get(id),
    }),
    DeviceSettings: async () => ({ hardwareDecoding: true, diagnostics: false }),
    Addons: async (id: number) => backend.addons.get(id) ?? [],
    KidsScope: async (id: number): Promise<KidsScope> =>
      backend.scopes.get(id) ?? { addons: [], catalogs: [] },
  },
}));

vi.mock("@bindings/secrets", () => ({ Service: { Available: async () => {} } }));

// A stand-in for internal/account's profile changes (#95), failing with a
// code in the cause as Wails passes it on.
const avatarImage = (id: string) =>
  `https://api.nuvio.tv/storage/v1/object/public/avatars/animals/${id}.png`;
function failed() {
  if (!backend.failChange) return;
  throw new Error("nuvio: failed", { cause: { code: backend.failChange } });
}
vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => backend.status,
    SwitchProfile: async (id: number) => {
      if (backend.failSwitch) throw new Error("disk full");
      backend.switches.push(id);
      backend.current = id;
      return backend.profiles.find((p) => p.id === id);
    },
    ApproveParent: async (id: number, pin: string) => {
      backend.approvals.push([id, pin]);
      if (backend.wrongPin)
        throw new Error("wrong PIN", {
          cause: { code: "wrong_pin", retryAfterSeconds: backend.pinRetry ?? 0 },
        });
    },
    SetKids: async (id: number, kids: boolean) => {
      failed();
      backend.kidsSets.push([id, kids]);
      const profile = backend.profiles.find((p) => p.id === id)!;
      profile.kids = kids;
      return profile;
    },
    SetKidsScope: async (id: number, scope: KidsScope) => {
      failed();
      backend.scopeSaves.push(scope);
      backend.scopes.set(id, scope);
    },
    SignOut: async () => {
      backend.signOuts += 1;
    },
    UnlockProfile: async (id: number, pin: string) => {
      backend.unlocks.push([id, pin]);
      if (backend.wrongPin)
        throw new Error("wrong PIN", {
          cause: { code: "wrong_pin", retryAfterSeconds: backend.pinRetry ?? 0 },
        });
    },
    SetProfilePIN: async (id: number, pin: string, currentPin: string) => {
      backend.pinSets.push([id, pin, currentPin]);
      if (backend.wrongCurrentPin)
        throw new Error("wrong current PIN", {
          cause: { code: "wrong_pin", retryAfterSeconds: 0 },
        });
      const p = backend.profiles.find((x) => x.id === id);
      if (p) p.pinEnabled = true;
    },
    ClearProfilePIN: async (id: number, currentPin: string) => {
      backend.pinClears.push([id, currentPin]);
      if (backend.wrongCurrentPin)
        throw new Error("wrong current PIN", {
          cause: { code: "wrong_pin", retryAfterSeconds: 0 },
        });
      const p = backend.profiles.find((x) => x.id === id);
      if (p) p.pinEnabled = false;
    },
    Avatars: async (): Promise<Avatar[]> => [
      { id: "otto", name: "Otto", image: avatarImage("otto"), color: "#0BB5AE" },
      { id: "pip", name: "Pip", image: avatarImage("pip"), color: "#45B5EE" },
    ],
    EditProfile: async (id: number, edit: ProfileEdit) => {
      failed();
      backend.edits.push([id, edit]);
      const profile = backend.profiles.find((p) => p.id === id)!;
      Object.assign(profile, {
        name: edit.name.trim(),
        ...(edit.avatarId && { avatar: avatarImage(edit.avatarId) }),
        ...(edit.avatarColor && { avatarColor: edit.avatarColor }),
      });
      return profile;
    },
    AddProfile: async (edit: ProfileEdit) => {
      failed();
      backend.edits.push(["add", edit]);
      const used = new Set(backend.profiles.map((p) => p.nuvioIndex));
      const added: Profile = {
        id: Math.max(...backend.profiles.map((p) => p.id)) + 1,
        name: edit.name.trim(),
        nuvioIndex: [1, 2, 3, 4, 5, 6].find((i) => !used.has(i))!,
        avatarColor: edit.avatarColor,
        ...(edit.avatarId && { avatar: avatarImage(edit.avatarId) }),
      };
      backend.profiles = [...backend.profiles, added];
      return added;
    },
    // As Go does: if it was current, the oldest one left takes over.
    DeleteProfile: async (id: number) => {
      failed();
      backend.profiles = backend.profiles.filter((p) => p.id !== id);
      if (backend.current === id) backend.current = backend.profiles[0]?.id ?? 0;
    },
  },
}));

const guest: Profile = { id: 1, name: "Guest", guest: true };
const kevin: Profile = {
  id: 2,
  name: "Kevin",
  nuvioIndex: 1,
  avatar: avatarImage("otto"),
  avatarColor: "#0BB5AE",
};
const kids: Profile = { id: 3, name: "Kids Room", nuvioIndex: 3, avatarColor: "#7957BD" };
const kidsPin: Profile = { id: 4, name: "Kids Room", nuvioIndex: 3, pinEnabled: true };
// A kids profile (#26): PIN-locked, with the PIN as the parent PIN.
const kidsOn: Profile = { id: 5, name: "Kids Room", nuvioIndex: 3, pinEnabled: true, kids: true };
const cinemeta: Addon = { url: "https://cinemeta/manifest.json", enabled: true };
const anime: Addon = { url: "https://anime/manifest.json", enabled: true };

function signedIn(current: Profile, ...profiles: Profile[]) {
  // Copies: the account stand-in edits them in place.
  backend.profiles = structuredClone(profiles);
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
  backend.unlocks = [];
  backend.wrongPin = false;
  backend.pinRetry = 0;
  backend.pinSets = [];
  backend.pinClears = [];
  backend.wrongCurrentPin = false;
  backend.failChange = "";
  backend.edits = [];
  backend.approvals = [];
  backend.kidsSets = [];
  backend.scopes.clear();
  backend.scopeSaves = [];
  backend.signOuts = 0;
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

    // Straight into Manage mode, where the Guest can be renamed but not
    // removed.
    await screen.findByRole("heading", { level: 1, name: "Manage profiles" });
    expect(screen.queryByRole("button", { name: "Add profile" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit Guest" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename the Guest" });
    expect(within(dialog).queryByRole("button", { name: "Remove" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
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

// Opens the picker's Manage mode.
async function manage() {
  await renderApp("/profiles", { shell: false });
  await userEvent.click(await screen.findByRole("button", { name: "Manage profiles" }));
  await screen.findByRole("heading", { level: 1, name: "Manage profiles" });
}

describe("managing profiles", () => {
  it("renames a Nuvio profile and changes its avatar and colour", async () => {
    signedIn(kevin, kevin, kids);
    const user = userEvent.setup();
    // Past the launch picker: Settings › Profiles › Manage opens it ready to
    // edit.
    const { router } = await renderApp("/profiles", { shell: false });
    await user.click(await tile("Kevin"));
    await screen.findByRole("button", { name: "Profile: Kevin" });
    await router.navigate({ to: "/settings" });
    await user.click(await screen.findByRole("link", { name: "Manage" }));
    await screen.findByRole("heading", { level: 1, name: "Manage profiles" });

    await user.click(await tile("Edit Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    expect(dialog).toHaveTextContent("Changes show on every device");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Little ones");
    // A stock avatar brings the colour it was drawn for…
    await user.click(await within(dialog).findByRole("radio", { name: "Pip" }));
    expect(within(dialog).getByRole("radio", { name: "#45B5EE" })).toBeChecked();
    // …which can still change.
    await user.click(within(dialog).getByRole("radio", { name: "#E53935" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved Little ones")).toBeInTheDocument();
    expect(backend.edits).toEqual([
      [kids.id, { name: "Little ones", avatarId: "pip", avatarColor: "#E53935" }],
    ]);
    expect(await tile("Edit Little ones")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Kids Room" })).toBeNull(),
    );
  });

  it("keeps the avatar when only the name changes", async () => {
    signedIn(kevin, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kevin"));
    const dialog = await screen.findByRole("dialog", { name: "Edit Kevin" });
    // Kevin's avatar is Otto, matched by its image.
    expect(await within(dialog).findByRole("radio", { name: "Otto" })).toBeChecked();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " M");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved Kevin M")).toBeInTheDocument();
    expect(backend.edits).toEqual([
      [kevin.id, { name: "Kevin M", avatarId: "", avatarColor: "#0BB5AE" }],
    ]);
  });

  it("adds a Nuvio profile", async () => {
    signedIn(kevin, guest, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await screen.findByRole("button", { name: "Add profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a profile" });
    expect(dialog).toHaveTextContent("starts empty");
    // Nothing to delete yet.
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Guests");
    await user.click(within(dialog).getByRole("button", { name: "Add profile" }));

    expect(await screen.findByText("Added Guests")).toBeInTheDocument();
    expect(backend.edits).toEqual([
      ["add", { name: "Guests", avatarId: "", avatarColor: "#33B5E0" }],
    ]);
    expect(await tile("Edit Guests")).toBeVisible();
  });

  it("says when all six Nuvio profiles are in use", async () => {
    const six = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 10 + i, name: `P${i}`, nuvioIndex: i }));
    signedIn(six[0]!, ...six);
    await manage();

    expect(
      await screen.findByText("All 6 Nuvio profiles are in use. Delete one to add another."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add profile" })).toBeNull();
  });

  it("deletes a Nuvio profile after saying it goes from every device", async () => {
    signedIn(kids, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    let dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Kids Room?" });
    expect(confirm).toHaveTextContent("deleted from Nuvio, on every device");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Deleted Kids Room")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Edit Kids Room" })).toBeNull(),
    );
    expect(backend.profiles.map((p) => p.name)).toEqual(["Kevin"]);

    // Kevin is the primary profile, and now the last: Nuvio keeps it.
    await user.click(await tile("Edit Kevin"));
    dialog = await screen.findByRole("dialog", { name: "Edit Kevin" });
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("explains a change that can't reach Nuvio, and keeps the edit open", async () => {
    signedIn(kevin, kevin, kids);
    backend.failChange = "unreachable";
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "!");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("Couldn’t reach Nuvio")).toBeVisible();
    expect(dialog).toHaveTextContent("needs a connection");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Kids Room!");
    expect(backend.profiles.find((p) => p.id === kids.id)?.name).toBe("Kids Room");
  });

  it("blocks Nuvio profiles while the session has ended, but renames the Guest", async () => {
    signedIn(guest, guest, kevin);
    backend.status = { signedIn: false, sessionEnded: true };
    const user = userEvent.setup();
    await manage();

    expect(await tile("Edit Kevin")).toBeDisabled();
    expect(screen.getByText(/Sign in again to change your Nuvio profiles/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add profile" })).toBeNull();

    await user.click(await tile("Edit Guest"));
    const dialog = await screen.findByRole("dialog", { name: "Rename the Guest" });
    // Local only: no avatars or colours from Nuvio.
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Visitors");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved Visitors")).toBeInTheDocument();
    expect(backend.edits).toEqual([
      [guest.id, { name: "Visitors", avatarId: "", avatarColor: "" }],
    ]);
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

describe("PIN-locked profiles", () => {
  it("picking a locked profile asks for the PIN, then unlocks and enters", async () => {
    signedIn(kevin, kevin, kidsPin);
    const user = userEvent.setup();
    const { router } = await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kids Room"));

    expect(await screen.findByRole("dialog", { name: "Enter PIN" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "4" }));

    expect(backend.unlocks).toEqual([[kidsPin.id, "1234"]]);
    expect(await screen.findByRole("button", { name: "Profile: Kids Room" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    // The gate must not come back after switching into the unlocked profile.
    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    expect(screen.queryByText("This profile is locked")).toBeNull();
  });

  it("types the PIN with the keyboard", async () => {
    signedIn(kevin, kevin, kidsPin);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Enter PIN" });

    // A physical keyboard types into the field rather than the keypad.
    await user.click(within(dialog).getByRole("textbox", { name: "PIN" }));
    await user.keyboard("1234");

    expect(backend.unlocks).toEqual([[kidsPin.id, "1234"]]);
    expect(await screen.findByRole("button", { name: "Profile: Kids Room" })).toBeVisible();
  });

  it("a wrong PIN shows the retry message and stays", async () => {
    signedIn(kevin, kevin, kidsPin);
    backend.wrongPin = true;
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Enter PIN" });

    await user.click(within(dialog).getByRole("button", { name: "1" }));
    await user.click(within(dialog).getByRole("button", { name: "2" }));
    await user.click(within(dialog).getByRole("button", { name: "3" }));
    await user.click(within(dialog).getByRole("button", { name: "4" }));

    expect(await within(dialog).findByText(/Wrong PIN/)).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Enter PIN" })).toBeVisible();

    backend.wrongPin = false;
    await user.click(within(dialog).getByRole("button", { name: "1" }));
    await user.click(within(dialog).getByRole("button", { name: "2" }));
    await user.click(within(dialog).getByRole("button", { name: "3" }));
    await user.click(within(dialog).getByRole("button", { name: "4" }));

    expect(await screen.findByRole("button", { name: "Profile: Kids Room" })).toBeVisible();
  });

  it("shows a lock note for a locked profile", async () => {
    signedIn(kevin, kevin, kidsPin);
    await renderApp("/profiles", { shell: false });
    await picker();

    expect(await tile("Kids Room")).toHaveAccessibleDescription("PIN");
  });

  it("editing a locked profile asks for the PIN first", async () => {
    signedIn(kevin, kevin, kidsPin);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });
    await user.click(await screen.findByRole("button", { name: "Manage profiles" }));
    await screen.findByRole("heading", { level: 1, name: "Manage profiles" });

    await user.click(await tile("Edit Kids Room"));

    expect(await screen.findByRole("dialog", { name: "Enter PIN" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Edit Kids Room" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "4" }));

    expect(await screen.findByRole("dialog", { name: "Edit Kids Room" })).toBeVisible();
  });

  it("gates a locked current profile at launch", async () => {
    signedIn(kidsPin, kidsPin);
    const user = userEvent.setup();
    const { router } = await renderApp("/");

    expect(await screen.findByText("This profile is locked")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "4" }));

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("setting, changing and clearing a PIN", () => {
  it("sets a PIN on an unlocked profile", async () => {
    signedIn(kevin, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    expect(within(dialog).getByText("No PIN set.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Set a PIN" }));

    const pinDialog = await screen.findByRole("dialog", { name: "Set a PIN" });
    expect(within(pinDialog).getByText("Choose a PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "3" }));
    await user.click(within(pinDialog).getByRole("button", { name: "4" }));
    expect(await within(pinDialog).findByText("Confirm the PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "3" }));
    await user.click(within(pinDialog).getByRole("button", { name: "4" }));

    expect(await screen.findByText("PIN set")).toBeInTheDocument();
    expect(backend.pinSets).toContainEqual([kids.id, "1234", ""]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Set a PIN" })).toBeNull());
    // The editor's PIN section now offers change and clear.
    expect(within(dialog).getByRole("button", { name: "Change PIN" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Clear PIN" })).toBeVisible();
  });

  it("sets a PIN typed with the keyboard", async () => {
    signedIn(kevin, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    const editor = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    await user.click(within(editor).getByRole("button", { name: "Set a PIN" }));

    const pinDialog = await screen.findByRole("dialog", { name: "Set a PIN" });
    await user.click(within(pinDialog).getByRole("textbox", { name: "PIN" }));
    await user.keyboard("1234");
    expect(await within(pinDialog).findByText("Confirm the PIN")).toBeVisible();
    await user.keyboard("1234");

    expect(await screen.findByText("PIN set")).toBeInTheDocument();
    expect(backend.pinSets).toContainEqual([kids.id, "1234", ""]);
  });

  it("retries a change when the current PIN is wrong, then applies it", async () => {
    signedIn(kevin, kevin, kidsPin);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });
    await user.click(await screen.findByRole("button", { name: "Manage profiles" }));
    await screen.findByRole("heading", { level: 1, name: "Manage profiles" });

    // Locked: unlock first, then edit.
    await user.click(await tile("Edit Kids Room"));
    await screen.findByRole("dialog", { name: "Enter PIN" });
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "4" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    await user.click(within(dialog).getByRole("button", { name: "Change PIN" }));

    const pinDialog = await screen.findByRole("dialog", { name: "Change PIN" });
    backend.wrongCurrentPin = true;
    // Wrong current PIN: collected now, refused only at the final submit.
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    expect(await within(pinDialog).findByText("Choose a PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    expect(await within(pinDialog).findByText("Confirm the PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    expect(await within(pinDialog).findByText("Wrong PIN. Try again.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Change PIN" })).toBeVisible();

    // Back to the current step, cleared, for the right PIN.
    backend.wrongCurrentPin = false;
    expect(within(pinDialog).getByText("Enter the current PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "3" }));
    await user.click(within(pinDialog).getByRole("button", { name: "4" }));
    expect(await within(pinDialog).findByText("Choose a PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "5" }));
    await user.click(within(pinDialog).getByRole("button", { name: "6" }));
    await user.click(within(pinDialog).getByRole("button", { name: "7" }));
    await user.click(within(pinDialog).getByRole("button", { name: "8" }));
    expect(await within(pinDialog).findByText("Confirm the PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "5" }));
    await user.click(within(pinDialog).getByRole("button", { name: "6" }));
    await user.click(within(pinDialog).getByRole("button", { name: "7" }));
    await user.click(within(pinDialog).getByRole("button", { name: "8" }));

    expect(await screen.findByText("PIN changed")).toBeInTheDocument();
    expect(backend.pinSets).toContainEqual([kidsPin.id, "5678", "1234"]);
  });

  it("clears a PIN after asking for the current one", async () => {
    signedIn(kevin, kevin, kidsPin);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });
    await user.click(await screen.findByRole("button", { name: "Manage profiles" }));
    await screen.findByRole("heading", { level: 1, name: "Manage profiles" });

    await user.click(await tile("Edit Kids Room"));
    await screen.findByRole("dialog", { name: "Enter PIN" });
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    await user.click(screen.getByRole("button", { name: "4" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    await user.click(within(dialog).getByRole("button", { name: "Clear PIN" }));

    const pinDialog = await screen.findByRole("dialog", { name: "Clear PIN" });
    expect(within(pinDialog).getByText("Enter the current PIN")).toBeVisible();
    await user.click(within(pinDialog).getByRole("button", { name: "1" }));
    await user.click(within(pinDialog).getByRole("button", { name: "2" }));
    await user.click(within(pinDialog).getByRole("button", { name: "3" }));
    await user.click(within(pinDialog).getByRole("button", { name: "4" }));

    expect(await screen.findByText("PIN cleared")).toBeInTheDocument();
    expect(backend.pinClears).toEqual([[kidsPin.id, "1234"]]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clear PIN" })).toBeNull());
    // The PIN section flips back to offering a set.
    expect(within(dialog).getByRole("button", { name: "Set a PIN" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Change PIN" })).toBeNull();
  });
});

async function enterPin(user: ReturnType<typeof userEvent.setup>, digits = "1234") {
  // One press after another, as a person types.
  for (const digit of digits) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await user.click(screen.getByRole("button", { name: digit }));
  }
}

describe("kids profiles", () => {
  it("marks a PIN-locked profile as kids and chooses the addons it shows", async () => {
    signedIn(kevin, kevin, kidsPin);
    backend.addons.set(kidsPin.id, [
      { ...cinemeta, name: "Cinemeta" },
      { ...anime, name: "Anime" },
    ]);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    // Locked, so its PIN first.
    await enterPin(user);
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });
    expect(within(dialog).queryByRole("switch", { name: "Cinemeta" })).toBeNull();

    await user.click(within(dialog).getByRole("switch", { name: "Only show what I choose" }));
    expect(backend.kidsSets).toEqual([[kidsPin.id, true]]);

    // Nothing is shown until the parent picks.
    expect(await within(dialog).findByText(/None is chosen yet/)).toBeVisible();
    await user.click(await within(dialog).findByRole("switch", { name: "Cinemeta" }));
    await waitFor(() =>
      expect(backend.scopeSaves).toEqual([{ addons: [cinemeta.url], catalogs: [] }]),
    );
    expect(within(dialog).getByRole("switch", { name: "Cinemeta" })).toBeChecked();
    expect(within(dialog).getByRole("switch", { name: "Anime" })).not.toBeChecked();

    await user.click(within(dialog).getByRole("switch", { name: "Cinemeta" }));
    await waitFor(() => expect(backend.scopeSaves.at(-1)).toEqual({ addons: [], catalogs: [] }));
  });

  it("needs a PIN before a profile can be a kids profile", async () => {
    signedIn(kevin, kevin, kids);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });

    expect(within(dialog).getByText(/Set a PIN first/)).toBeVisible();
    expect(within(dialog).getByRole("switch", { name: "Only show what I choose" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps a kids profile's PIN: it can't be cleared while kids is on", async () => {
    signedIn(kevin, kevin, kidsOn);
    const user = userEvent.setup();
    await manage();

    await user.click(await tile("Edit Kids Room"));
    // Its parent PIN to open the editor.
    expect(await screen.findByRole("dialog", { name: "Enter parent PIN" })).toBeVisible();
    await enterPin(user);
    const dialog = await screen.findByRole("dialog", { name: "Edit Kids Room" });

    expect(backend.approvals).toEqual([[kidsOn.id, "1234"]]);
    expect(within(dialog).getByRole("button", { name: "Change PIN" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Clear PIN" })).toBeNull();
    expect(within(dialog).getByRole("switch", { name: "Only show what I choose" })).toBeChecked();
  });

  it("marks a kids profile in the picker", async () => {
    signedIn(kevin, kevin, kidsOn);
    await renderApp("/profiles", { shell: false });

    expect(await tile("Kids Room")).toHaveAccessibleDescription("Kids");
  });

  it("leaving a kids profile asks for the parent PIN", async () => {
    signedIn(kidsOn, kevin, kidsOn);
    const user = userEvent.setup();
    const { router } = await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kevin"));

    expect(await screen.findByRole("dialog", { name: "Enter parent PIN" })).toBeVisible();
    expect(backend.switches).toEqual([]);
    await enterPin(user);

    expect(backend.approvals).toEqual([[kidsOn.id, "1234"]]);
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
    expect(backend.switches).toEqual([kevin.id]);
    expect(router.state.location.pathname).toBe("/");
  });

  it("stays in the kids profile when the parent PIN is cancelled or wrong", async () => {
    signedIn(kidsOn, kevin, kidsOn);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kevin"));
    await screen.findByRole("dialog", { name: "Enter parent PIN" });
    backend.wrongPin = true;
    await enterPin(user, "0000");
    expect(await screen.findByText("Wrong PIN. Try again.")).toBeVisible();
    expect(backend.switches).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.switches).toEqual([]);
  });

  it("asks for the parent PIN, then Kevin's own, to go from kids to a locked profile", async () => {
    const lockedKevin: Profile = { ...kevin, pinEnabled: true };
    signedIn(kidsOn, lockedKevin, kidsOn);
    const user = userEvent.setup();
    await renderApp("/profiles", { shell: false });

    await user.click(await tile("Kevin"));
    await screen.findByRole("dialog", { name: "Enter parent PIN" });
    await enterPin(user, "1111");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Enter PIN" })).toBeVisible());
    await enterPin(user, "2222");

    expect(backend.approvals).toEqual([[kidsOn.id, "1111"]]);
    expect(backend.unlocks).toEqual([[lockedKevin.id, "2222"]]);
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
  });

  it("adding a profile from a kids profile asks for the parent PIN", async () => {
    signedIn(kidsOn, kevin, kidsOn);
    const user = userEvent.setup();
    await manage();

    await user.click(await screen.findByRole("button", { name: "Add profile" }));
    expect(await screen.findByRole("dialog", { name: "Enter parent PIN" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Add a profile" })).toBeNull();
    await enterPin(user);

    expect(await screen.findByRole("dialog", { name: "Add a profile" })).toBeVisible();
  });

  it("signing out of a kids profile asks for the parent PIN first", async () => {
    signedIn(kidsOn, kevin, kidsOn);
    const user = userEvent.setup();
    const { router } = await renderApp("/profiles", { shell: false });
    // Unlocked, as the parent did to hand it over.
    await user.click(await tile("Kids Room"));
    await enterPin(user);
    await screen.findByRole("button", { name: "Profile: Kids Room" });
    backend.approvals = [];
    await router.navigate({ to: "/settings" });

    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Sign out of Nuvio?" });
    await user.click(within(confirm).getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("dialog", { name: "Enter parent PIN" })).toBeVisible();
    expect(backend.signOuts).toBe(0);
    await enterPin(user);

    await waitFor(() => expect(backend.signOuts).toBe(1));
    expect(backend.approvals).toEqual([[kidsOn.id, "1234"]]);
  });
});

describe("initials colour", () => {
  it("picks whichever of black and white reads better", () => {
    expect(initialsColor("#33B5E0")).toBe("#0A0A0A");
    expect(initialsColor("#7957BD")).toBe("#FFFFFF");
    expect(initialsColor("#B9E53A")).toBe("#0A0A0A");
  });
});
