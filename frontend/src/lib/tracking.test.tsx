import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Meta } from "@/lib/addon-protocol";
import type { Connections, TitleRef, TitleTracking } from "@bindings/tracking";

import {
  connectedServices,
  statusesFor,
  titleRef,
  titleTrackingQuery,
  trackingActionProblem,
  useSetTrackingRating,
  useSetTrackingStatus,
  watchlistQuery,
} from "@/lib/tracking";

const mocks = vi.hoisted(() => ({
  TitleStatus: vi.fn<(id: number, ref: unknown) => Promise<unknown>>(),
  SetStatus: vi.fn<(id: number, ref: unknown, status: string) => Promise<unknown>>(),
  SetRating: vi.fn<(id: number, ref: unknown, rating: number) => Promise<unknown>>(),
  Watchlist: vi.fn<(id: number) => Promise<unknown>>(),
}));

vi.mock("@bindings/tracking", () => ({ Service: mocks }));

const noConnections: Connections = {
  simklAvailable: true,
  anilistAvailable: true,
  kids: false,
  simkl: null,
  anilist: null,
};
const simklLink = { user: "k", needsReconnect: false, importedAt: 0 };
const simklOnly: Connections = { ...noConnections, simkl: simklLink };
const both: Connections = {
  ...simklOnly,
  anilist: { user: "k", needsReconnect: false, expires: 0, importedAt: 0 },
};

const ref: TitleRef = {
  type: "series",
  id: "tt0903747",
  name: "Breaking Bad",
  year: 2008,
  ids: {},
};
const none: TitleTracking = { status: "none", rating: 0, services: [], queued: false };

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => vi.resetAllMocks());

describe("which statuses to offer", () => {
  it("offers nothing without a usable connection", () => {
    expect(statusesFor(undefined, "series")).toEqual([]);
    expect(statusesFor({ ...simklOnly, kids: true }, "series")).toEqual([]);
    const stale = { ...simklOnly, simkl: { ...simklLink, needsReconnect: true } };
    expect(connectedServices(stale)).toEqual([]);
  });

  it("leaves out what SIMKL keeps no film as", () => {
    expect(statusesFor(simklOnly, "movie")).toEqual(["planned", "completed", "dropped", "none"]);
    expect(statusesFor(simklOnly, "series")).toHaveLength(6);
    // AniList takes the lot, and a film can be anime.
    expect(statusesFor(both, "movie")).toHaveLength(6);
  });
});

describe("titleRef", () => {
  it("takes the meta's ids and year, and treats every other type as a series", () => {
    expect(
      titleRef({ type: "anime", id: "kitsu:1" }, "Cowboy Bebop", {
        id: "kitsu:1",
        type: "series",
        name: "Cowboy Bebop",
        releaseInfo: "1998–1999",
        imdb_id: "tt0213338",
      } satisfies Meta),
    ).toEqual({
      type: "series",
      id: "kitsu:1",
      name: "Cowboy Bebop",
      year: 1998,
      ids: { imdb: "tt0213338" },
    });
    expect(titleRef({ type: "movie", id: "tt1" }, "X").year).toBe(0);
  });
});

describe("queries", () => {
  it("reads a title's status and the watchlist through Go", async () => {
    const { queryClient } = setup();
    mocks.TitleStatus.mockResolvedValue({ ...none, status: "paused" });
    mocks.Watchlist.mockResolvedValue([]);
    await expect(queryClient.fetchQuery(titleTrackingQuery(1, ref))).resolves.toMatchObject({
      status: "paused",
    });
    expect(mocks.TitleStatus).toHaveBeenCalledWith(1, ref);
    await queryClient.fetchQuery(watchlistQuery(1));
    expect(mocks.Watchlist).toHaveBeenCalledWith(1);
    // Both sit under the profile's tracking key, which tracking:changed refreshes.
    expect(titleTrackingQuery(1, ref).queryKey.slice(0, 2)).toEqual(["tracking", 1]);
    expect(watchlistQuery(1).queryKey.slice(0, 2)).toEqual(["tracking", 1]);
  });
});

describe("mutations", () => {
  it("shows a status at once, then keeps Go's answer and marks the watchlist stale", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(titleTrackingQuery(1, ref).queryKey, none);
    queryClient.setQueryData(watchlistQuery(1).queryKey, []);
    let answer!: (value: TitleTracking) => void;
    mocks.SetStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useSetTrackingStatus(1, ref), { wrapper });
    act(() => result.current.mutate("planned"));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<TitleTracking>(titleTrackingQuery(1, ref).queryKey)?.status,
      ).toBe("planned"),
    );
    expect(mocks.SetStatus).toHaveBeenCalledWith(1, ref, "planned");
    answer({ status: "planned", rating: 0, services: ["simkl"], queued: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData<TitleTracking>(titleTrackingQuery(1, ref).queryKey)?.services,
    ).toEqual(["simkl"]);
    // No screen shows the watchlist here, so it's marked stale, to load when one does.
    expect(queryClient.getQueryState(watchlistQuery(1).queryKey)?.isInvalidated).toBe(true);
  });

  it("puts the old status back when Go refuses", async () => {
    const { queryClient, wrapper } = setup();
    const before = { ...none, status: "watching" };
    queryClient.setQueryData(titleTrackingQuery(1, ref).queryKey, before);
    mocks.SetStatus.mockRejectedValue(new Error("no"));
    const { result } = renderHook(() => useSetTrackingStatus(1, ref), { wrapper });
    act(() => result.current.mutate("dropped"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(titleTrackingQuery(1, ref).queryKey)).toEqual(before);
  });

  it("rates, and clears with 0", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(titleTrackingQuery(1, ref).queryKey, none);
    mocks.SetRating.mockImplementation((_id, _ref, rating) => Promise.resolve({ ...none, rating }));
    const { result } = renderHook(() => useSetTrackingRating(1, ref), { wrapper });
    act(() => result.current.mutate(8));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<TitleTracking>(titleTrackingQuery(1, ref).queryKey)?.rating,
      ).toBe(8),
    );
    act(() => result.current.mutate(0));
    await waitFor(() => expect(mocks.SetRating).toHaveBeenLastCalledWith(1, ref, 0));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<TitleTracking>(titleTrackingQuery(1, ref).queryKey)?.rating,
      ).toBe(0),
    );
  });
});

describe("trackingActionProblem", () => {
  it("explains the codes Go gives", () => {
    const error = new Error("x", { cause: { code: "kids_profile" } });
    expect(trackingActionProblem(error).title).toMatch(/Kids/);
    expect(
      trackingActionProblem(new Error("x", { cause: { code: "not_trackable" } })).title,
    ).toMatch(/Neither/);
    expect(trackingActionProblem(new Error("x")).title).toMatch(/Couldn’t update/);
  });
});
