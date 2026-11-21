import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Download, Profile } from "@bindings/store";
import { onCompactIOS } from "@/test/ios";
import { renderApp } from "@/test/render-app";

// The Library's Downloads view (#85, ADR-0064): what the device holds, what is
// on its way, and the way to Settings › Downloads.
const mocks = vi.hoisted(() => ({
  current: vi.fn<() => Promise<Profile>>(),
  list: vi.fn<(profileId: number) => Promise<Download[]>>(),
  usage: vi.fn<() => Promise<{ used: number; cap: number; free: number; dir: string }>>(),
  pause: vi.fn<(profileId: number, id: string) => Promise<void>>(),
  resume: vi.fn<(profileId: number, id: string) => Promise<void>>(),
  remove: vi.fn<(profileId: number, ids: string[] | null) => Promise<void>>(),
}));

vi.mock("@bindings/downloads", () => ({
  Service: {
    Add: () => Promise.resolve(undefined),
    ChooseFolder: () => Promise.resolve(""),
    Delete: mocks.remove,
    DeleteAll: () => Promise.resolve(undefined),
    Get: () => Promise.resolve(null),
    List: mocks.list,
    Network: () => Promise.resolve({ online: true, expensive: false }),
    Pause: mocks.pause,
    Playable: () => Promise.resolve(null),
    Resume: mocks.resume,
    Usage: mocks.usage,
  },
}));

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: () => mocks.current().then((p) => [p]),
    CurrentProfile: mocks.current,
    // The shell asks this on iOS (lib/device-languages): the audio
    // languages of a local profile with no settings yet. Nothing seeded.
    SeedAudioLanguages: () => Promise.resolve(false),
    Addons: () => Promise.resolve([]),
    VisibleAddons: () => Promise.resolve([]),
    Library: () => Promise.resolve([]),
    LastWatched: () => Promise.resolve({}),
    ContinueWatching: () => Promise.resolve([]),
    SaveLibraryItem: () => Promise.resolve(),
    RemoveLibraryItem: () => Promise.resolve(),
  },
}));

// No TMDB key: the title-page prefetch in the shell asks the keychain.
vi.mock("@bindings/secrets", () => ({ Service: { Get: () => Promise.resolve(null) } }));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: true, sessionEnded: false }) },
}));

vi.mock("@bindings/syncer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Service: {
    Pull: () => Promise.reject(new Error("offline")),
    Connection: () => Promise.resolve("offline"),
    CheckConnection: () => Promise.resolve("offline"),
  },
}));

const kevin = { id: 1, name: "Kevin", nuvioIndex: 1 } as Profile;

// A record as Go's store keeps it: a finished episode unless a test says
// otherwise.
const download = (changes: Partial<Download> = {}): Download => ({
  id: "a1",
  profileId: 1,
  contentId: "tt0903747",
  contentType: "series",
  videoId: "tt0903747:1:2",
  season: 1,
  episode: 2,
  name: "Breaking Bad",
  episodeName: "Grilled",
  poster: "https://example.test/breaking-bad.jpg",
  metaAddon: "https://addon.example/manifest.json",
  streamSource: "https://addon.example/manifest.json",
  streamName: "TorBox 1080p",
  streamDescription: "Breaking.Bad.S01E02.1080p.mkv",
  resolution: "1080p",
  request: { url: "https://cdn.example/file.mkv", headers: null },
  root: "",
  file: "a1/video.mkv",
  mimeType: "video/x-matroska",
  subtitles: null,
  segments: null,
  state: "done",
  reason: "",
  bytes: 1_400_000_000,
  total: 1_400_000_000,
  createdAt: 1,
  updatedAt: 1,
  doneAt: 1_000,
  ...changes,
});

const episode = download();
// A film downloaded after the episode: the Downloaded group is newest first.
const film = download({
  id: "a2",
  contentId: "tt0113277",
  contentType: "movie",
  videoId: "tt0113277",
  season: 0,
  episode: 0,
  name: "Heat",
  episodeName: "",
  poster: "https://example.test/heat.jpg",
  file: "a2/video.mkv",
  bytes: 1_400_000_000,
  total: 1_400_000_000,
  createdAt: 2,
  updatedAt: 2,
  doneAt: 2_000,
});
const downloading = download({
  id: "b1",
  contentId: "kitsu:46474",
  contentType: "anime",
  videoId: "kitsu:46474:1:3",
  season: 1,
  episode: 3,
  name: "Frieren",
  episodeName: "Killer Instinct",
  poster: "https://example.test/frieren.jpg",
  state: "downloading",
  file: "b1/video.mkv.part",
  bytes: 42_000_000,
  total: 900_000_000,
  createdAt: 3,
  updatedAt: 3,
  doneAt: 0,
});
const paused = download({
  id: "b2",
  contentId: "tt0078748",
  contentType: "movie",
  videoId: "tt0078748",
  season: 0,
  episode: 0,
  name: "Alien",
  episodeName: "",
  poster: "https://example.test/alien.jpg",
  state: "paused",
  file: "b2/video.mkv.part",
  bytes: 500_000_000,
  total: 2_000_000_000,
  createdAt: 4,
  updatedAt: 4,
  doneAt: 0,
});
const failed = download({
  id: "b3",
  contentId: "tt0112641",
  contentType: "movie",
  videoId: "tt0112641",
  season: 0,
  episode: 0,
  name: "Casino",
  episodeName: "",
  poster: "https://example.test/casino.jpg",
  state: "failed",
  reason: "no_space",
  file: "b3/video.mkv.part",
  bytes: 200_000_000,
  total: 3_000_000_000,
  createdAt: 5,
  updatedAt: 5,
  doneAt: 0,
});
const queued = download({
  id: "b4",
  contentId: "tt0133093",
  contentType: "movie",
  videoId: "tt0133093",
  season: 0,
  episode: 0,
  name: "The Matrix",
  episodeName: "",
  poster: "https://example.test/matrix.jpg",
  state: "queued",
  file: "b4/video.mkv.part",
  bytes: 0,
  total: 0,
  createdAt: 6,
  updatedAt: 6,
  doneAt: 0,
});

// A row, found by the name its poster-and-text button gives it: "Play …" once
// it's downloaded, "Go to …" until then.
const primary = (label: string) =>
  screen.findByRole("button", { name: new RegExp(`^(Play|Go to) ${label}`) });
const rowOf = async (label: string) => (await primary(label)).closest("li")!;
const action = async (label: string, name: string) =>
  within(await rowOf(label)).getByRole("button", { name });

let restore: (() => void) | undefined;

beforeEach(() => {
  mocks.current.mockResolvedValue(kevin);
  mocks.list.mockResolvedValue([]);
  mocks.usage.mockResolvedValue({
    used: 12_300_000_000,
    cap: 50_000_000_000,
    free: 210_000_000_000,
    dir: "/tmp/Peli/Downloads",
  });
  mocks.pause.mockResolvedValue(undefined);
  mocks.resume.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  // Offline: nothing on the page needs the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("offline"))),
  );
});

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllGlobals();
});

describe("downloads view", () => {
  it("says there are no downloads yet", async () => {
    await renderApp("/library?view=downloads");

    expect(await screen.findByRole("heading", { name: "No downloads yet" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Download films and episodes from their page to watch them without a connection.",
      ),
    ).toBeInTheDocument();
    const tabs = await screen.findByRole("tablist", { name: "View" });
    const tab = await within(tabs).findByRole("tab", { name: "Downloads" });
    await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"));
    expect(mocks.list).toHaveBeenCalledWith(kevin.id);
  });

  it("shows it to a kids profile too", async () => {
    mocks.current.mockResolvedValue({ ...kevin, kids: true });
    await renderApp("/library?view=downloads");

    expect(await screen.findByRole("heading", { name: "No downloads yet" })).toBeInTheDocument();
    const tabs = await screen.findByRole("tablist", { name: "View" });
    expect(within(tabs).getByRole("tab", { name: "Downloads" })).toBeInTheDocument();
    expect(within(tabs).queryByRole("tab", { name: "Watchlist" })).not.toBeInTheDocument();
  });

  it("lists what is on its way, then what is downloaded, newest first", async () => {
    mocks.list.mockResolvedValue([episode, film, downloading, paused, failed, queued]);
    await renderApp("/library?view=downloads");

    expect(await screen.findByRole("heading", { name: "Downloading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Downloaded" })).toBeInTheDocument();

    // The queue first, each row saying how it stands.
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Failed: Not enough space")).toBeInTheDocument();
    // 42 MB of 900 MB.
    expect(screen.getByText("Downloading 5 %")).toBeInTheDocument();

    // An episode says which one, a film just its stream. The code sits in its
    // own tabular span (as Upcoming's rows have it), so read the row's text
    // rather than one node.
    expect(await rowOf("Breaking Bad · S1 E2")).toHaveTextContent("S1 · E2 · Grilled");
    expect(await rowOf("Heat")).toHaveTextContent("1080p · 1.4 GB");
    expect(await rowOf("Frieren · S1 E3")).toHaveTextContent("1080p · 900 MB");

    // The downloaded ones, most recently downloaded first.
    const plays = await screen.findAllByRole("button", { name: /^Play / });
    expect(plays.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Play Heat",
      "Play Breaking Bad · S1 E2",
    ]);
  });

  it("pauses a download, resumes a paused one and retries a failed one", async () => {
    mocks.list.mockResolvedValue([downloading, paused, failed]);
    await renderApp("/library?view=downloads");

    const user = userEvent.setup();
    await user.click(await action("Frieren · S1 E3", "Pause Frieren · S1 E3"));
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith(kevin.id, downloading.id));

    await user.click(await action("Alien", "Resume Alien"));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(kevin.id, paused.id));

    await user.click(await action("Casino", "Retry Casino"));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(kevin.id, failed.id));
  });

  it("cancels an unfinished download without asking", async () => {
    mocks.list.mockResolvedValue([downloading]);
    await renderApp("/library?view=downloads");

    const user = userEvent.setup();
    await user.click(await action("Frieren · S1 E3", "Cancel Frieren · S1 E3"));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(kevin.id, [downloading.id]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before deleting a finished download", async () => {
    mocks.list.mockResolvedValue([episode]);
    await renderApp("/library?view=downloads");

    const user = userEvent.setup();
    await user.click(await action("Breaking Bad · S1 E2", "Delete Breaking Bad · S1 E2"));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete Breaking Bad · S1 E2?",
    });
    expect(
      within(dialog).getByText("You’ll need a connection to download it again."),
    ).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(kevin.id, [episode.id]));
  });

  it("deletes the selected downloads together", async () => {
    mocks.list.mockResolvedValue([downloading, paused]);
    await renderApp("/library?view=downloads");

    fireEvent.click(await primary("Frieren · S1 E3"), { metaKey: true });
    fireEvent.click(await primary("Alien"), { metaKey: true });

    const bar = await screen.findByRole("toolbar", { name: "Selection" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(kevin.id, [downloading.id, paused.id]),
    );
  });

  it("says how much room the downloads take, and the way to Settings", async () => {
    mocks.list.mockResolvedValue([film]);
    await renderApp("/library?view=downloads");

    expect(await screen.findByText("12 GB of 50 GB used · 210 GB free")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings › Downloads" })).toHaveAttribute(
      "href",
      "/settings?section=downloads",
    );
  });

  it("works in the iPhone's compact frame, where the row menu deletes one", async () => {
    restore = onCompactIOS();
    mocks.list.mockResolvedValue([film]);
    await renderApp("/library?view=downloads");

    expect(document.querySelector('[data-slot="compact-library"]')).not.toBeNull();
    // The compact row's own line: the state, the stream and the size.
    expect(await rowOf("Heat")).toHaveTextContent("Downloaded · 1080p · 1.4 GB");

    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "More for Heat" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Heat" });
    await user.click(within(sheet).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete Heat?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(kevin.id, [film.id]));
  });
});
