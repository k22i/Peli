import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Overview, Repository } from "@bindings/plugins";
import type { Profile } from "@bindings/store";
import { renderApp } from "@/test/render-app";

// An in-memory stand-in for internal/plugins' management calls.
type Fake = {
  overview: Overview;
  installError: string | undefined;
  calls: string[];
  profile: Profile;
  // A Wails call that applies a change.
  edit: (name: string, apply: () => void) => Promise<void> & { cancel: () => void };
};

const fake = vi.hoisted((): Fake => ({
  overview: { kids: false, enabled: false, repositories: [] },
  installError: undefined,
  calls: [],
  profile: { id: 1, name: "Kevin", nuvioIndex: 1 },
  edit(name, apply) {
    this.calls.push(name);
    apply();
    return Object.assign(Promise.resolve(), { cancel: () => {} });
  },
}));

const echo = {
  id: "echo",
  name: "Echo",
  version: "1.2",
  supportedTypes: ["movie", "tv"],
  file: "https://repo.example/echo.js",
  enabled: true,
};
const second = { ...echo, id: "second", name: "Second", enabled: false };
const repository: Repository = {
  url: "https://repo.example/plugins/manifest.json?token=secret",
  name: "Example repo",
  enabled: true,
  supported: true,
  version: "1",
  fetchedAt: 1,
  plugins: [echo, second],
};
const cloudstream: Repository = {
  url: "https://phone.example/repo.cs3",
  name: "Phone only",
  enabled: true,
  supported: false,
  version: "",
  fetchedAt: 0,
  plugins: [],
};

// Go's errors reach the frontend as {code}, on the error's cause.
const goError = (code: string) => Object.assign(new Error(code), { cause: { code } });

vi.mock("@bindings/plugins", () => {
  return {
    Service: {
      Installed: () => Promise.resolve([]),
      Refresh: () => Promise.resolve(0),
      Overview: () => Promise.resolve(structuredClone(fake.overview)),
      SetEnabled: (_: number, enabled: boolean) =>
        fake.edit(`enable:${enabled}`, () => {
          fake.overview.enabled = enabled;
        }),
      InstallRepository: (_: number, link: string) => {
        fake.calls.push(`install:${link}`);
        if (fake.installError) return Promise.reject(goError(fake.installError));
        fake.overview.repositories = [...(fake.overview.repositories ?? []), repository];
        return Promise.resolve(repository);
      },
      RemoveRepository: (_: number, link: string) =>
        fake.edit(`remove:${link}`, () => {
          fake.overview.repositories = (fake.overview.repositories ?? []).filter(
            (r) => r.url !== link,
          );
        }),
      EnableRepository: (_: number, link: string, enabled: boolean) =>
        fake.edit(`repo:${enabled}`, () => {
          for (const r of fake.overview.repositories ?? []) {
            if (r.url === link) r.enabled = enabled;
          }
        }),
      EnablePlugin: (_: number, id: string, enabled: boolean) =>
        fake.edit(`plugin:${id}:${enabled}`, () => {
          for (const r of fake.overview.repositories ?? []) {
            for (const p of r.plugins ?? []) if (p.id === id) p.enabled = enabled;
          }
        }),
    },
  };
});

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => Promise.resolve([fake.profile]),
    CurrentProfile: () => Promise.resolve(fake.profile),
    Addons: () => Promise.resolve([]),
    ProfileSettings: () => Promise.reject(new Error("not used")),
  },
}));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.resolve({ profileId: 1, surfaces: [] }),
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.installError = undefined;
  fake.profile = { id: 1, name: "Kevin", nuvioIndex: 1 };
  fake.overview = { kids: false, enabled: false, repositories: [] };
});

// The "Add…" button, not the "Addons & content" chip in the pane rail.
const addRepository = /^Add(?!ons)/;

const open = async () => {
  await renderApp("/settings?section=plugins");
  return screen.findByRole("switch", { name: "Use plugins" });
};

describe("settings › plugins", () => {
  it("is off by default and shows nothing to install", async () => {
    const toggle = await open();

    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/No plugin is ever asked for streams/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: addRepository })).not.toBeInTheDocument();
  });

  it("turns on only after the warning says what plugins are", async () => {
    const user = userEvent.setup();
    const toggle = await open();

    await user.click(toggle);
    const warning = await screen.findByRole("alertdialog", { name: "Turn on plugins?" });
    for (const phrase of [
      /third-party scrapers/,
      /doesn’t check what they do/,
      /break, return fake or unsafe links/,
      /responsible for the repositories you install/,
    ]) {
      expect(within(warning).getByText(phrase)).toBeInTheDocument();
    }
    expect(fake.calls).toEqual([]);

    // Cancelling leaves it off.
    await user.click(within(warning).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(fake.calls).toEqual([]);
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "I understand, turn on",
      }),
    );
    await waitFor(() => expect(fake.calls).toEqual(["enable:true"]));
    await waitFor(() => expect(toggle).toBeChecked());
    expect(await screen.findByRole("button", { name: addRepository })).toBeInTheDocument();
  });

  it("turns off without asking", async () => {
    fake.overview.enabled = true;
    const user = userEvent.setup();
    const toggle = await open();

    await user.click(toggle);

    await waitFor(() => expect(fake.calls).toEqual(["enable:false"]));
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("installs a repository from its address and lists it with its source", async () => {
    fake.overview.enabled = true;
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole("button", { name: addRepository }));
    const dialog = await screen.findByRole("dialog", { name: "Add a plugin repository" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Manifest address" }),
      "https://repo.example/plugins",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(fake.calls).toEqual(["install:https://repo.example/plugins"]));
    expect(await screen.findByText("Example repo")).toBeInTheDocument();
    // The source: host and path, never the query, which can hold a token.
    expect(screen.getByText("repo.example/plugins/manifest.json")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret");
    expect(screen.getByText("2 plugins")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Echo" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Second" })).not.toBeChecked();
  });

  it("says why an address was refused and keeps the dialog open", async () => {
    fake.overview.enabled = true;
    fake.installError = "not_a_repository";
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole("button", { name: addRepository }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "https://nope.example");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(await within(dialog).findByText(/No plugins found/)).toBeInTheDocument();
    expect(screen.queryByText("Example repo")).not.toBeInTheDocument();
  });

  it("turns a plugin and a repository on and off", async () => {
    fake.overview = { kids: false, enabled: true, repositories: [repository] };
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole("switch", { name: "Second" }));
    await waitFor(() => expect(fake.calls).toEqual(["plugin:second:true"]));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Second" })).toBeChecked());

    await user.click(screen.getByRole("switch", { name: "Use Example repo" }));
    await waitFor(() => expect(fake.calls).toContain("repo:false"));
    // With its repository off, a repository's plugins can't be turned on.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Echo" })).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("removes a repository after asking", async () => {
    fake.overview = { kids: false, enabled: true, repositories: [repository] };
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole("button", { name: "Remove Example repo" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Example repo?" });
    expect(fake.calls).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(fake.calls).toEqual([`remove:${repository.url}`]));
    await waitFor(() => expect(screen.queryByText("Example repo")).not.toBeInTheDocument());
  });

  it("lists a repository Peli can't run, without plugin switches", async () => {
    fake.overview = { kids: false, enabled: true, repositories: [cloudstream] };
    await open();

    expect(await screen.findByText("Phone only")).toBeInTheDocument();
    expect(screen.getByText(/Android only/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use Phone only" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Phone only" })).toBeInTheDocument();
  });

  it("shows no controls on a kids profile", async () => {
    fake.profile = { id: 1, name: "Kids", nuvioIndex: 1, kids: true };
    fake.overview = { kids: true, enabled: false, repositories: [] };
    await renderApp("/settings?section=plugins");

    expect(await screen.findByText("Kids profiles don’t use plugins.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: addRepository })).not.toBeInTheDocument();
  });
});
