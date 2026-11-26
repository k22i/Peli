import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeviceSettings, Profile } from "@bindings/store";

import { Downloads, formatBytes, type Usage } from "@/lib/downloads";
import { deviceSettings } from "@/test/fixtures";
import { onIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// Settings › Downloads (#85, ADR-0064): where the files go, how much room they
// get, whether the phone waits for Wi-Fi, and the one destructive row. The
// device's settings are an in-memory stand-in for the Go store's.

const store = vi.hoisted(() => ({
  kids: false,
  device: undefined as DeviceSettings | undefined,
}));

const profile = (): Profile => ({ id: 2, name: "Ben Ito", kids: store.kids });

vi.mock("@bindings/store", async () => {
  const fixtures = await import("@/test/fixtures");
  return {
    Service: {
      Profiles: () => Promise.resolve([profile()]),
      CurrentProfile: () => Promise.resolve(profile()),
      Addons: () => Promise.resolve([]),
      ProfileSettings: () => Promise.resolve(fixtures.profileSettings()),
      SaveProfileSettings: () => Promise.resolve(),
      DeviceSettings: () => Promise.resolve(store.device ?? fixtures.deviceSettings()),
      // The pane saves the whole record, as every other device row does.
      SaveDeviceSettings: (settings: DeviceSettings) => {
        store.device = settings;
        return Promise.resolve();
      },
      // What the iOS shell calls once a profile is in use: the audio-language
      // seed runs in an effect, so a missing method here is a thrown render,
      // not a failed query, and the whole app shows the error screen instead
      // of the pane. The other three are ProfileGate's icon-menu sync, which
      // asks them through queries.
      SeedAudioLanguages: () => Promise.resolve(false),
      ContinueWatching: () => Promise.resolve([]),
      Library: () => Promise.resolve([]),
      VisibleAddons: () => Promise.resolve([]),
    },
  };
});

// No TMDB key: the title-page prefetch in the shell asks the keychain.
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.resolve({ profileId: 2, surfaces: [] }),
    Connection: () => Promise.resolve("online"),
    CheckConnection: () => Promise.resolve("online"),
  },
}));

// What Go says the device holds and has room for. 12.3 GB used and 210 GB
// free, as decimal units (the screens' formatBytes) show them.
const folder = "/Users/kevin/Movies/Peli";

const usage = (changes: Partial<Usage> = {}): Usage => ({
  used: 12_300_000_000,
  cap: 50_000_000_000,
  free: 210_000_000_000,
  dir: folder,
  ...changes,
});

const usageLine = `${formatBytes(12_300_000_000)} used · ${formatBytes(210_000_000_000)} free on this disk`;

beforeEach(() => {
  store.kids = false;
  store.device = undefined;
  vi.mocked(Downloads.Usage).mockClear();
  vi.mocked(Downloads.ChooseFolder).mockClear();
  vi.mocked(Downloads.DeleteAll).mockClear();
  vi.mocked(Downloads.Usage).mockResolvedValue(usage());
  vi.mocked(Downloads.ChooseFolder).mockResolvedValue("");
});

// Opens the pane and waits for its rows: the device's settings and what Go
// says the downloads hold both have to arrive.
async function openDownloads(line = usageLine) {
  const result = await renderApp("/settings?section=downloads");
  await screen.findByText(line);
  return result;
}

describe("settings › downloads", () => {
  it("shows the folder, the cap with what it holds, and Delete all", async () => {
    await openDownloads();

    expect(screen.getByRole("heading", { level: 2, name: "Downloads" })).toBeVisible();
    expect(
      screen.getByText("Downloads stay on this device and play without a connection."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "This device" })).toBeVisible();

    // The desktop's folder: what Go counts downloads in, under the row.
    expect(screen.getByText("Location")).toBeVisible();
    expect(screen.getByText(folder)).toBeVisible();
    expect(screen.getByText("New downloads go here; existing ones stay put.")).toBeVisible();
    // The default folder is Go's, so there is nothing to put back.
    expect(screen.queryByRole("button", { name: "Use default" })).not.toBeInTheDocument();

    const cap = screen.getByRole("combobox", { name: "Storage limit" });
    expect(cap).toHaveTextContent("50 GB");
    expect(cap).toHaveAccessibleDescription(usageLine);
    // A desktop jam is not a phone's data plan: no Wi-Fi row there.
    expect(
      screen.queryByRole("switch", { name: "Download over Wi-Fi only" }),
    ).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Delete all…" })).toBeEnabled();
  });

  it("saves the storage limit with the device's settings", async () => {
    const user = userEvent.setup();
    await openDownloads();

    await user.click(screen.getByRole("combobox", { name: "Storage limit" }));
    await user.click(await screen.findByRole("option", { name: "100 GB" }));

    await waitFor(() => expect(store.device?.downloadsCapGB).toBe(100));
  });

  // Choosing a folder is Go's dialog, and it saves what it was given; the
  // pane then asks again what the folder holds.
  it("asks Go for a new folder and asks the usage again", async () => {
    const user = userEvent.setup();
    await openDownloads();
    const asked = vi.mocked(Downloads.Usage).mock.calls.length;
    vi.mocked(Downloads.ChooseFolder).mockResolvedValue("/Volumes/Media/Peli");

    await user.click(screen.getByRole("button", { name: "Change…" }));

    await waitFor(() => expect(Downloads.ChooseFolder).toHaveBeenCalledExactlyOnceWith(2));
    await waitFor(() =>
      expect(vi.mocked(Downloads.Usage).mock.calls.length).toBeGreaterThan(asked),
    );
  });

  it("puts a custom folder back to the default, which moves the usage", async () => {
    store.device = deviceSettings({ downloadsDir: folder });
    const user = userEvent.setup();
    await openDownloads();
    const asked = vi.mocked(Downloads.Usage).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Use default" }));

    await waitFor(() => expect(store.device?.downloadsDir).toBe(""));
    // New downloads go to Go's own folder now, so what it counts moved.
    await waitFor(() =>
      expect(vi.mocked(Downloads.Usage).mock.calls.length).toBeGreaterThan(asked),
    );
  });

  it("asks before deleting every download, then deletes them all", async () => {
    const user = userEvent.setup();
    await openDownloads();

    await user.click(screen.getByRole("button", { name: "Delete all…" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete all downloads on this device?",
    });
    expect(within(confirm).getByText("Every profile’s downloads are removed.")).toBeVisible();
    expect(Downloads.DeleteAll).not.toHaveBeenCalled();

    // Cancelling changes nothing.
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(Downloads.DeleteAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete all…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete all downloads",
      }),
    );

    await waitFor(() => expect(Downloads.DeleteAll).toHaveBeenCalledExactlyOnceWith(2));
  });

  it("has nothing to delete when the device holds no downloads", async () => {
    const free = 226_700_000_000;
    vi.mocked(Downloads.Usage).mockResolvedValue(usage({ used: 0, free }));
    await openDownloads(`${formatBytes(0)} used · ${formatBytes(free)} free on this disk`);

    expect(screen.getByRole("button", { name: "Delete all…" })).toBeDisabled();
  });

  // The phone's own row (ADR-0064): its jobs wait while the network is
  // expensive instead of spending the user's data.
  it("offers Wi-Fi only downloads on iOS, and saves the switch", async () => {
    onIOS();
    store.device = deviceSettings({ downloadsWiFiOnly: false });
    const user = userEvent.setup();
    await openDownloads();

    const wifi = screen.getByRole("switch", { name: "Download over Wi-Fi only" });
    expect(wifi).not.toBeChecked();
    expect(wifi).toHaveAccessibleDescription("Downloads wait for Wi-Fi, not mobile data.");

    await user.click(wifi);

    await waitFor(() => expect(store.device?.downloadsWiFiOnly).toBe(true));
  });

  it("leaves the folder out on iOS, where there is no dialog to pick one", async () => {
    onIOS();
    await openDownloads();

    expect(screen.queryByText("Location")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change…" })).not.toBeInTheDocument();
  });

  // A kids profile downloads, but the folder and the device's whole library of
  // downloads are a parent's: Go refuses both with kids_profile.
  it("hides the folder and Delete all from a kids profile", async () => {
    store.kids = true;
    await openDownloads();

    expect(screen.queryByText("Location")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete all…" })).not.toBeInTheDocument();
    // What a kid may still see: how much room the downloads have.
    expect(screen.getByRole("combobox", { name: "Storage limit" })).toBeVisible();
  });
});
