import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import { Service as Downloads } from "@bindings/downloads";
import type { Download } from "@bindings/store";
import { DownloadStatus } from "@/components/shell/download-status";
import { ToastProvider } from "@/components/ui/toast";
import { setDownloadTrayOpen } from "@/lib/download-tray";
import { downloadsKey } from "@/lib/downloads";
import type { PlayTarget } from "@/lib/playback";
import { onCompactIOS } from "@/test/ios";

// The download button in the top bar (#85 follow-up, ADR-0064): hidden with
// nothing to say, a ring with the tray's percent while a job runs, the tray
// itself in a popover (the desktop and the iPad) or a bottom sheet (the
// iPhone), and a "Downloaded" toast with Play when a job finishes.

// What usePlay is handed, and the haptics the button asks for.
const mocks = vi.hoisted(() => ({ play: vi.fn<(target: PlayTarget) => void>() }));

vi.mock("@/lib/haptics", () => ({ haptic: vi.fn<(kind: string) => void>() }));
const { haptic } = await import("@/lib/haptics");

// The one way to play, spied so the toast's action can be read as its target
// (the real one asks Go, resolves streams and navigates: other tests' work).
vi.mock("@/lib/playback", () => ({ usePlay: () => mocks.play }));

// The profile in use, without the store: this file is about the button.
vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentProfileQuery: {
    queryKey: ["profiles", "current"],
    queryFn: () => Promise.resolve({ id: 1, name: "Kevin" }),
  },
}));

// The store's other screens ask these as they load (lib/settings, lib/title).
vi.mock("@bindings/store", () => ({
  Service: {
    CurrentProfile: () => Promise.resolve({ id: 1, name: "Kevin" }),
    SeedAudioLanguages: () => Promise.resolve(),
  },
}));

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: false, sessionEnded: false }) },
}));

// Part A's tray, stubbed: the list it draws, and the two helpers the button
// reads computed the way the real ones are (a stub keeps this file
// independent of that part's work).
vi.mock("@/components/downloads/tray-list", () => ({
  DownloadTrayList: ({
    profileId,
    touch,
    onNavigate,
  }: {
    profileId: number;
    touch: boolean;
    onNavigate: () => void;
  }) => (
    <div>
      <p>
        Tray for profile {profileId}, {touch ? "touch" : "pointer"}
      </p>
      <button type="button" onClick={onNavigate}>
        Close the tray
      </button>
    </div>
  ),
  trayDownloads: (list: readonly Download[]) => [...list],
  overallPercent: (list: readonly Download[]) => {
    const running = list.filter((download) => download.state !== "done");
    const total = running.reduce((sum, download) => sum + download.total, 0);
    if (total <= 0) return undefined;
    const bytes = running.reduce((sum, download) => sum + download.bytes, 0);
    return Math.min(100, Math.round((bytes / total) * 100));
  },
}));

// A record as the store keeps it: an episode of Severance, downloading.
function download(changes: Partial<Download> = {}): Download {
  return {
    id: "a1",
    profileId: 1,
    contentId: "tt11280740",
    contentType: "series",
    videoId: "tt11280740:1:2",
    season: 1,
    episode: 2,
    name: "Severance",
    episodeName: "Half Loop",
    poster: "",
    metaAddon: "https://v3-cinemeta.strem.io/manifest.json",
    streamSource: "https://torrentio.strem.fun/manifest.json",
    streamName: "Torrentio",
    streamDescription: "",
    resolution: "1080p",
    request: { url: "https://cdn.example/severance.mkv", headers: null },
    root: "",
    file: "a1/video.mkv",
    mimeType: "video/x-matroska",
    subtitles: null,
    segments: null,
    state: "downloading",
    reason: "",
    bytes: 420_000_000,
    total: 1_000_000_000,
    createdAt: 1,
    updatedAt: 2,
    doneAt: 0,
    ...changes,
  };
}

// The button as the tests read it, and the app's list as Go answers it.
const button = (name: string | RegExp) => screen.findByRole("button", { name });

let restoreMatchMedia: (() => void) | undefined;

beforeEach(() => {
  setDownloadTrayOpen(false);
  vi.mocked(Downloads.List).mockImplementation(() =>
    CancellablePromise.resolve<Download[] | null>([]),
  );
});

afterEach(() => {
  restoreMatchMedia?.();
  restoreMatchMedia = undefined;
});

function renderStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DownloadStatus />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe("download status", () => {
  it("keeps the bar to the profile with nothing downloading", async () => {
    const client = renderStatus();

    await waitFor(() => expect(client.getQueryData(downloadsKey(1))).toEqual([]));
    expect(screen.queryByRole("button", { name: /Downloads/ })).toBeNull();
    expect(Downloads.List).toHaveBeenCalledWith(1);
  });

  it("shows the tray's percent beside the profile, and opens the tray from it", async () => {
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([download()]),
    );
    const user = userEvent.setup();
    renderStatus();

    await user.click(await button("Downloads, 1 in progress, 42 %"));

    const popover = await screen.findByRole("dialog", { name: "Downloads" });
    expect(within(popover).getByText("Tray for profile 1, pointer")).toBeInTheDocument();
    // The tray's own rows close it.
    await user.click(screen.getByRole("button", { name: "Close the tray" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Downloads" })).toBeNull());
  });

  it("says a job's progress is unknown with a turning ring, not a percent", async () => {
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([download({ total: 0, bytes: 0 })]),
    );
    renderStatus();

    expect(await button("Downloads, 1 in progress")).toBeInTheDocument();
  });

  it("turns into a check for a download that finished while the app is open", async () => {
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([
        // Finished in this session, and after the tray was last looked at (an
        // earlier test opened it), so it is unseen.
        download({ state: "done", bytes: 1_000_000_000, doneAt: Date.now() + 1 }),
      ]),
    );
    renderStatus();

    const shown = await button("Downloads, 1 finished");
    // The check and its dot, not the progress ring.
    expect(shown.querySelector("[data-slot=download-ring]")).toBeNull();
    expect(shown.querySelector("[data-slot=download-unseen]")).toBeInTheDocument();
  });

  it("says nothing about a download that finished before the app opened", async () => {
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([
        download({ state: "done", bytes: 1_000_000_000, doneAt: 1 }),
      ]),
    );
    const client = renderStatus();

    await waitFor(() => expect(client.getQueryData(downloadsKey(1))).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Downloads/ })).toBeNull();
    expect(screen.queryByText("Downloaded")).toBeNull();
  });

  it("opens a bottom sheet named Downloads on the iPhone, with a tap's haptic", async () => {
    restoreMatchMedia = onCompactIOS();
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([download()]),
    );
    const user = userEvent.setup();
    renderStatus();

    await user.click(await button("Downloads, 1 in progress, 42 %"));

    const sheet = await screen.findByRole("dialog", { name: "Downloads" });
    expect(within(sheet).getByText("Tray for profile 1, touch")).toBeInTheDocument();
    expect(haptic).toHaveBeenCalledWith("light");
  });

  it("toasts a finished download with Play, and buzzes on the iPhone", async () => {
    restoreMatchMedia = onCompactIOS();
    vi.mocked(Downloads.List).mockImplementation(() =>
      CancellablePromise.resolve<Download[] | null>([download()]),
    );
    const user = userEvent.setup();
    const client = renderStatus();
    await button("Downloads, 1 in progress, 42 %");

    // downloads:changed, as Go sends it: the same record, done.
    const done = download({ state: "done", bytes: 1_000_000_000, doneAt: Date.now() });
    act(() => client.setQueryData<Download[]>(downloadsKey(1), [done]));

    expect(await screen.findByText("Downloaded")).toBeInTheDocument();
    expect(screen.getByText("Severance · S1 E2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(mocks.play).toHaveBeenCalledWith({
      type: "series",
      id: "tt11280740",
      title: "Severance",
      videoId: "tt11280740:1:2",
    });
    expect(haptic).toHaveBeenCalledWith("success");
  });
});
