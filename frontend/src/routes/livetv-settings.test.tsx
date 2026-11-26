import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import type { Profile } from "@bindings/store";

import { sourceStatus, updatedLabel } from "@/components/settings/livetv-pane";
import { LiveTV, type Source } from "@/lib/livetv";
import { renderApp } from "@/test/render-app";

// Settings › Live TV (ADR-0066): a profile's IPTV sources, what each one
// loaded and when, the buttons that refresh, rename and remove one, and the
// last row that adds another. Go fetches and parses the playlist and the
// guide; the pane reads what it answered and asks for the rest.

const store = vi.hoisted(() => ({ kids: false }));

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
      DeviceSettings: () => Promise.resolve(fixtures.deviceSettings()),
      SaveDeviceSettings: () => Promise.resolve(),
      // What the iOS shell calls once a profile is in use: the audio-language
      // seed runs in an effect, so a missing method here is a thrown render,
      // not a failed query. The other three are ProfileGate's icon-menu sync,
      // which asks them through queries.
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

// A record as Go answers one: a playlist that loaded five minutes ago with a
// guide, unless a test says otherwise. Every field is filled, so a case is one
// change away.
const now = Date.now();

const source = (changes: Partial<Source> = {}): Source => ({
  id: "a1",
  profileId: 2,
  name: "Pluto",
  createdAt: now - 7 * 24 * 60 * 60_000,
  updatedAt: now - 5 * 60_000,
  hasGuide: true,
  guideFromPlaylist: false,
  channels: 1234,
  guideChannels: 400,
  programmes: 6000,
  playlistAt: now - 5 * 60_000,
  guideAt: now - 5 * 60_000,
  playlistError: "",
  guideError: "",
  refreshing: false,
  ...changes,
});

// What Go answers Sources with: these sources, in this order.
function sources(list: Source[]) {
  vi.mocked(LiveTV.Sources).mockImplementation(() =>
    CancellablePromise.resolve<Source[] | null>(list),
  );
}

beforeEach(() => {
  store.kids = false;
  sources([]);
});

// Opens the pane at ?section=livetv. The Live TV entry is in the pane list
// whether or not the profile has a source: it is where one is added.
async function openLive() {
  const result = await renderApp("/settings?section=livetv");
  await screen.findByRole("heading", { level: 2, name: "Live TV" });
  return result;
}

describe("settings › live tv", () => {
  it("says what each source loaded and how long ago", async () => {
    const at = Date.now() - 5 * 60_000;
    sources([
      source({ playlistAt: at, guideAt: at }),
      source({
        id: "b2",
        name: "Freeview",
        channels: 900,
        guideError: "not_guide",
        playlistAt: at,
      }),
    ]);
    await openLive();

    expect(
      screen.getByText(
        "Channels from an IPTV playlist (M3U) and a programme guide (XMLTV). Links stay in the keychain, as they can hold a password.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Sources" })).toBeVisible();
    expect(
      screen.getByText("Playlists update every 12 hours, guides every 6. Refresh updates one now."),
    ).toBeVisible();

    // The counts and the age come from Go; the age is the locale's to word,
    // so the expected line is built the way the row builds it.
    expect(
      await screen.findByText(`1,234 channels · Guide for 400 · ${updatedLabel(at, Date.now())}`),
    ).toBeVisible();
    expect(
      screen.getByText(`900 channels · Guide didn’t load · ${updatedLabel(at, Date.now())}`),
    ).toBeVisible();
    // A source's row is its name and what it loaded: never a link.
    expect(screen.getByText("Pluto")).toBeVisible();
    expect(screen.getByText("Freeview")).toBeVisible();
  });

  it("says why a playlist didn’t load", async () => {
    sources([source({ playlistError: "unreachable" })]);
    await openLive();

    expect(await screen.findByText("Playlist didn’t load: the link didn’t answer.")).toBeVisible();
  });

  it("says a source is updating, and can’t be refreshed again", async () => {
    sources([source({ refreshing: true })]);
    await openLive();

    expect(await screen.findByText("Updating…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh Pluto" })).toBeDisabled();
  });

  it("refreshes one source now", async () => {
    const user = userEvent.setup();
    sources([source()]);
    await openLive();

    await user.click(await screen.findByRole("button", { name: "Refresh Pluto" }));

    await waitFor(() => expect(LiveTV.Refresh).toHaveBeenCalledExactlyOnceWith(2, "a1"));
  });

  it("adds a source from a playlist link", async () => {
    const user = userEvent.setup();
    await openLive();

    expect(await screen.findByText("Add a source")).toBeVisible();
    expect(
      screen.getByText("An M3U or M3U8 link, a file:// link or a file on this device."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add…" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a Live TV source" });
    // Nothing to add without a playlist, so Add waits for one.
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Playlist link"), "https://example.com/list.m3u");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    // The name and the guide were left empty: Go takes the playlist's own.
    await waitFor(() =>
      expect(LiveTV.AddSource).toHaveBeenCalledExactlyOnceWith({
        profileId: 2,
        name: "",
        playlistUrl: "https://example.com/list.m3u",
        guideUrl: "",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add a Live TV source" }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Source added")).toBeVisible();
  });

  it("says what a refused link needs, and keeps the dialog open", async () => {
    const user = userEvent.setup();
    vi.mocked(LiveTV.AddSource).mockImplementation(() =>
      CancellablePromise.reject<Source>(new Error("x", { cause: { code: "invalid" } })),
    );
    await openLive();

    await user.click(await screen.findByRole("button", { name: "Add…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Live TV source" });
    await user.type(within(dialog).getByLabelText("Playlist link"), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Enter an http(s) link, a file:// link or a file path.",
    );
    expect(screen.getByRole("dialog", { name: "Add a Live TV source" })).toBeVisible();
  });

  it("renames a source", async () => {
    const user = userEvent.setup();
    sources([source()]);
    await openLive();

    await user.click(await screen.findByRole("button", { name: "Rename Pluto" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename source" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Pluto");

    // A blank name is not a rename.
    await user.clear(name);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(name, "New name");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(LiveTV.RenameSource).toHaveBeenCalledExactlyOnceWith(2, "a1", "New name"),
    );
  });

  it("asks before removing a source, then removes it", async () => {
    const user = userEvent.setup();
    sources([source()]);
    await openLive();

    await user.click(await screen.findByRole("button", { name: "Remove Pluto" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Pluto?" });
    expect(
      within(confirm).getByText(
        "Its channels, favourites and guide leave Peli on this device. The playlist itself isn’t touched.",
      ),
    ).toBeVisible();
    expect(LiveTV.RemoveSource).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(LiveTV.RemoveSource).toHaveBeenCalledExactlyOnceWith(2, "a1"));
  });

  it("has no sources to offer a kids profile", async () => {
    store.kids = true;
    await openLive();

    expect(await screen.findByText("Kids profiles don’t have Live TV.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add…" })).not.toBeInTheDocument();
  });
});

// Go's answer as the pane words it, without a screen in the way. The clocks
// here are fixed: nothing reads the real one.
const at = 1_700_000_000_000;
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

describe("sourceStatus", () => {
  it("answers the first case that applies", () => {
    // A refresh under way outranks whatever the last try left behind.
    expect(sourceStatus(source({ refreshing: true, playlistError: "unreachable" }), at)).toBe(
      "Updating…",
    );
    expect(sourceStatus(source({ playlistError: "unreachable" }), at)).toBe(
      "Playlist didn’t load: the link didn’t answer.",
    );
    expect(sourceStatus(source({ playlistError: "timeout" }), at)).toBe(
      "Playlist didn’t load: it took too long.",
    );
    expect(sourceStatus(source({ playlistError: "too_large" }), at)).toBe(
      "Playlist didn’t load: it’s too large.",
    );
    expect(sourceStatus(source({ playlistError: "not_playlist" }), at)).toBe(
      "Playlist didn’t load: there are no channels in it.",
    );
    expect(sourceStatus(source({ playlistError: "failed" }), at)).toBe("Playlist didn’t load.");
    expect(sourceStatus(source({ playlistAt: 0 }), at)).toBe("Not updated yet");
  });

  it("counts one channel in the singular, and says how old the playlist is", () => {
    expect(
      sourceStatus(source({ channels: 1, guideChannels: 1, playlistAt: at }), at + 30_000),
    ).toBe("1 channel · Guide for 1 · Updated just now");
    expect(sourceStatus(source({ hasGuide: false, playlistAt: at }), at + 30_000)).toBe(
      "1,234 channels · No guide · Updated just now",
    );
    expect(sourceStatus(source({ guideError: "not_guide", playlistAt: at }), at + 30_000)).toBe(
      "1,234 channels · Guide didn’t load · Updated just now",
    );
    expect(sourceStatus(source({ playlistAt: at }), at + 5 * minute)).toBe(
      "1,234 channels · Guide for 400 · Updated 5 minutes ago",
    );
  });
});

describe("updatedLabel", () => {
  it("says how long ago the playlist loaded", () => {
    expect(updatedLabel(at, at + 30_000)).toBe("Updated just now");
    expect(updatedLabel(at, at + minute)).toBe("Updated 1 minute ago");
    expect(updatedLabel(at, at + 5 * minute)).toBe("Updated 5 minutes ago");
    expect(updatedLabel(at, at + 3 * hour)).toBe("Updated 3 hours ago");
    // Two days, not one: the formatter words a single day as "yesterday".
    expect(updatedLabel(at, at + 2 * day)).toBe("Updated 2 days ago");
  });
});
