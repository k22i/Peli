import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";

import { flushPushes, useSyncEvents, useSyncProfile } from "@/lib/sync";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { data: unknown }) => void>(),
  pull: vi.fn<() => Promise<unknown>>(),
  flush: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@wailsio/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof Runtime>();
  return {
    ...runtime,
    Events: {
      ...runtime.Events,
      On: (name: string, callback: (event: { data: unknown }) => void) => {
        mocks.handlers.set(name, callback);
        return () => mocks.handlers.delete(name);
      },
    },
  };
});

vi.mock("@bindings/syncer", () => ({ Service: { Pull: mocks.pull, Flush: mocks.flush } }));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useSyncEvents", () => {
  it("refreshes the queries of the surfaces a pull changed", async () => {
    const fetched = { library: 0, progress: 0, watched: 0, other: 0 };
    // The screens showing each query, mounted.
    renderHook(
      () => {
        useSyncEvents();
        useQuery({
          queryKey: ["library", 1],
          queryFn: () => ++fetched.library,
          staleTime: Infinity,
        });
        useQuery({
          queryKey: ["continue-watching", 1],
          queryFn: () => ++fetched.progress,
          staleTime: Infinity,
        });
        useQuery({
          queryKey: ["watched", 1, "tt1"],
          queryFn: () => ++fetched.watched,
          staleTime: Infinity,
        });
        useQuery({
          queryKey: ["profiles", "all"],
          queryFn: () => ++fetched.other,
          staleTime: Infinity,
        });
      },
      { wrapper: wrapper(new QueryClient()) },
    );
    await waitFor(() => expect(fetched).toEqual({ library: 1, progress: 1, watched: 1, other: 1 }));

    mocks.handlers.get("sync:pulled")?.({
      data: { profileId: 1, surfaces: ["library", "progress"] },
    });

    await waitFor(() => expect(fetched).toEqual({ library: 2, progress: 2, watched: 1, other: 1 }));
  });

  it("copes with a pull that changed nothing", () => {
    const queryClient = new QueryClient();
    renderHook(() => useSyncEvents(), { wrapper: wrapper(queryClient) });
    expect(() =>
      mocks.handlers.get("sync:pulled")?.({ data: { profileId: 1, surfaces: null } }),
    ).not.toThrow();
  });

  it("stops listening when unmounted", () => {
    const { unmount } = renderHook(() => useSyncEvents(), {
      wrapper: wrapper(new QueryClient()),
    });
    expect(mocks.handlers.has("sync:pulled")).toBe(true);
    unmount();
    expect(mocks.handlers.has("sync:pulled")).toBe(false);
  });
});

describe("useSyncProfile", () => {
  it("asks Go to pull when the profile in use changes", () => {
    mocks.pull.mockResolvedValue({ profileId: 1, surfaces: [] });
    const { rerender } = renderHook(({ id }) => useSyncProfile(id), {
      initialProps: { id: undefined as number | undefined },
    });
    expect(mocks.pull).not.toHaveBeenCalled();
    rerender({ id: 1 });
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    rerender({ id: 1 });
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    rerender({ id: 2 });
    expect(mocks.pull).toHaveBeenCalledTimes(2);
  });

  it("ignores a pull that fails", async () => {
    mocks.pull.mockRejectedValue(new Error("offline"));
    renderHook(() => useSyncProfile(1));
    await waitFor(() => expect(mocks.pull).toHaveBeenCalled());
  });
});

describe("flushPushes", () => {
  it("asks Go to push now, and shrugs off a failed push", async () => {
    mocks.flush.mockResolvedValueOnce(undefined);
    await flushPushes();
    expect(mocks.flush).toHaveBeenCalledTimes(1);

    mocks.flush.mockRejectedValueOnce(new Error("offline"));
    await expect(flushPushes()).resolves.toBeUndefined();
    expect(mocks.flush).toHaveBeenCalledTimes(2);
  });
});
