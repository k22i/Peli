import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { createQueryClient } from "@/lib/query";
import { addonsQuery, manifestUrl, useEditAddons } from "@/lib/addons";

const account = vi.hoisted(() => ({
  InstallAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  RemoveAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  MoveAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  EnableAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@bindings/account", () => ({ Service: account }));
vi.mock("@bindings/store", () => ({ Service: { Addons: () => Promise.resolve([]) } }));

describe("manifestUrl", () => {
  it("finds the manifest from what Nuvio and Stremio store", () => {
    expect(manifestUrl("https://v3-cinemeta.strem.io/manifest.json")).toBe(
      "https://v3-cinemeta.strem.io/manifest.json",
    );
    expect(manifestUrl("https://opensubtitles-v3.strem.io")).toBe(
      "https://opensubtitles-v3.strem.io/manifest.json",
    );
    expect(manifestUrl("https://addon.example/config/")).toBe(
      "https://addon.example/config/manifest.json",
    );
    expect(manifestUrl("stremio://addon.example/manifest.json")).toBe(
      "https://addon.example/manifest.json",
    );
  });
});

describe("useEditAddons", () => {
  it("makes each edit in Go and rereads the list", async () => {
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    await queryClient.fetchQuery(addonsQuery(7));
    const { result } = renderHook(() => useEditAddons(7), { wrapper });
    const addon = { url: "https://a/manifest.json", name: "A", enabled: true };

    await act(() => result.current.mutateAsync({ kind: "install", addon }));
    await act(() => result.current.mutateAsync({ kind: "move", url: addon.url, to: 0 }));
    await act(() => result.current.mutateAsync({ kind: "enable", url: addon.url, enabled: false }));
    await act(() => result.current.mutateAsync({ kind: "remove", url: addon.url }));

    expect(account.InstallAddon).toHaveBeenCalledWith(7, addon);
    expect(account.MoveAddon).toHaveBeenCalledWith(7, addon.url, 0);
    expect(account.EnableAddon).toHaveBeenCalledWith(7, addon.url, false);
    expect(account.RemoveAddon).toHaveBeenCalledWith(7, addon.url);
    expect(queryClient.getQueryState(addonsQuery(7).queryKey)?.isInvalidated).toBe(true);
  });
});
