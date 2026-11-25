import { QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import { Service as Player } from "@bindings/player";
import type { Source } from "@bindings/streams";
import { GuideGrid } from "@/components/livetv/guide-grid";
import { ToastProvider } from "@/components/ui/toast";
import {
  LiveTV,
  clockLabel,
  guideRange,
  type Channel,
  type ChannelGuide,
  type Programme,
} from "@/lib/livetv";
import { createQueryClient } from "@/lib/query";

// The guide view of /live (W6): the time axis, a row for each channel with its
// programmes on it, what a click on a block does, and the details behind a
// programme that isn't on now.

// The profile in use and its settings; no addons, which the guide never asks
// for. The settings come from the shared fixture, so a new field breaks there.
vi.mock("@bindings/store", async () => {
  const { profileSettings } = await import("@/test/fixtures");
  const profile = { id: 1, name: "Kevin" };
  return {
    Service: {
      CurrentProfile: () => Promise.resolve(profile),
      Profiles: () => Promise.resolve([profile]),
      ProfileSettings: () => Promise.resolve(profileSettings()),
      Addons: () => Promise.resolve([]),
      VisibleAddons: () => Promise.resolve([]),
    },
  };
});

vi.mock("@bindings/account", () => ({
  Service: { Status: () => Promise.resolve({ signedIn: false, sessionEnded: false }) },
}));

// Playing a channel loads the stream Go hands over; the player itself is
// another test's work.
vi.mock("@bindings/player", () => ({
  Service: {
    Load: vi.fn(() => Promise.resolve()),
    Snapshot: vi.fn(() => Promise.resolve(null)),
    Stop: vi.fn(() => Promise.resolve()),
  },
}));

// 2026-11-25 20:10 UTC, in the order the guide's "now" reads.
const now = Date.UTC(2026, 10, 25, 20, 10);
const at = (hour: number, minute: number) => Date.UTC(2026, 10, 25, hour, minute);

const channel = (changes: Partial<Channel> = {}): Channel => ({
  id: "s1:bbc1",
  sourceId: "s1",
  number: 1,
  name: "BBC One",
  logo: "",
  group: "News",
  tvgId: "bbc1",
  tvgName: "BBC One",
  ...changes,
});

const bbc = channel();
const itv = channel({ id: "s1:itv", number: 2, name: "ITV", group: "Entertainment" });
const four = channel({ id: "s1:four", number: 3, name: "Channel 4" });

const programme = (changes: Partial<Programme> = {}): Programme => ({
  channelId: bbc.id,
  start: at(20, 0),
  stop: at(21, 0),
  title: "News at Eight",
  subTitle: "",
  description: "",
  categories: [],
  episode: "",
  icon: "",
  ...changes,
});

// On now, or on over the half hour either side of it.
const news = programme();
const quiz = programme({ channelId: itv.id, title: "The Quiz", start: at(20, 30), stop: at(21, 30) });
const film = programme({ channelId: four.id, title: "A Film", start: at(19, 0), stop: at(21, 0) });
// Still to come, with everything the details dialog draws.
const later = programme({
  title: "Later Show",
  start: at(21, 0),
  stop: at(22, 0),
  subTitle: "Series 2",
  description: "A cookery contest.",
  categories: ["Cookery"],
});

const guideOf = (of: Channel, programmes: Programme[]): ChannelGuide => ({
  channelId: of.id,
  programmes,
});

// What Go answers for every guide ask: each channel's programmes. A channel
// left out has none, which is what "No guide" says.
function serving(guides: ChannelGuide[]) {
  vi.mocked(LiveTV.Guide).mockImplementation(() =>
    CancellablePromise.resolve<ChannelGuide[]>(guides),
  );
}

const blockName = (of: Programme, on = false) =>
  `${of.title}, ${clockLabel(of.start)} to ${clockLabel(of.stop)}${on ? ", on now" : ""}`;

// The grid through the app's providers and a router of its own. usePlayChannel
// opens the player once the stream loads, so the router has a route for it: a
// click then plays for real rather than catching a failed navigation.
function renderGuide(channels: Channel[]) {
  const root = createRootRoute({
    component: () => <GuideGrid channels={channels} group="" />,
  });
  const player = createRoute({
    getParentRoute: () => root,
    path: "/player",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([player]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("GuideGrid", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(now));
    // jsdom lays nothing out, so a virtualizer with the scroll container's own
    // zeroed size mounts no rows. Give every element a laptop's viewport.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1280,
    });
    vi.mocked(Player.Load).mockImplementation(() => CancellablePromise.resolve<void>(undefined));
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    vi.useRealTimers();
  });

  it("draws the time axis and a row of programmes for each channel", async () => {
    serving([guideOf(bbc, [news]), guideOf(itv, [quiz]), guideOf(four, [film])]);
    renderGuide([bbc, itv, four]);

    expect(await screen.findByRole("region", { name: "Programme guide" })).toBeInTheDocument();
    // The axis runs 36 hours, so a clock time can show on more than one day.
    expect(screen.getAllByText(clockLabel(at(20, 0))).length).toBeGreaterThan(0);
    expect(await screen.findByText("BBC One")).toBeInTheDocument();
    expect(screen.getByText("ITV")).toBeInTheDocument();
    expect(screen.getByText("Channel 4")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: blockName(news, true) }),
    ).toBeInTheDocument();
  });

  it("plays the channel from a block that's on now", async () => {
    const source: Source = {
      url: "https://cdn.example/live/bbc1.m3u8",
      origin: `livetv:${bbc.id}`,
      headers: {},
      userAgent: "",
      contentType: "",
      size: 0,
    };
    serving([guideOf(bbc, [news])]);
    vi.mocked(LiveTV.Stream).mockImplementation(() =>
      CancellablePromise.resolve<Source>(source),
    );
    renderGuide([bbc]);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole("button", { name: blockName(news, true) }));

    await waitFor(() => expect(LiveTV.Stream).toHaveBeenCalledWith(1, bbc.id));
    await waitFor(() =>
      expect(Player.Load).toHaveBeenCalledWith(source, expect.objectContaining({ start: 0 })),
    );
  });

  it("opens a programme that isn't on now, and closes it", async () => {
    serving([guideOf(bbc, [news, later])]);
    renderGuide([bbc]);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole("button", { name: blockName(later) }));

    const dialog = await screen.findByRole("dialog", { name: "Later Show" });
    expect(within(dialog).getByText(/BBC One/)).toBeInTheDocument();
    expect(within(dialog).getByText("Series 2")).toBeInTheDocument();
    expect(within(dialog).getByText("A cookery contest.")).toBeInTheDocument();
    expect(within(dialog).getByText("Cookery")).toBeInTheDocument();

    // The footer's Close comes before the popup's own ✕ in the DOM.
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("asks for the guide of every channel it shows, over its own range", async () => {
    const range = guideRange(now);
    serving([guideOf(bbc, [news])]);
    renderGuide([bbc, itv, four]);

    await waitFor(() =>
      expect(LiveTV.Guide).toHaveBeenCalledWith(
        1,
        [bbc.id, itv.id, four.id],
        range.from,
        range.to,
      ),
    );
  });

  it("says a channel has no guide", async () => {
    serving([guideOf(bbc, [news])]);
    renderGuide([bbc, itv]);

    expect(await screen.findByText("No guide")).toBeInTheDocument();
  });
});
