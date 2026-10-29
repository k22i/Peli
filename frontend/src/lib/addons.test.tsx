import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { createQueryClient } from "@/lib/query";
import { addonLink, addonsQuery, applyAddonEdit, configureUrl, useEditAddons } from "@/lib/addons";

const account = vi.hoisted(() => ({
  InstallAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  InsertAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  ReconfigureAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  RemoveAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  MoveAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  EnableAddon: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@bindings/account", () => ({ Service: account }));
vi.mock("@bindings/store", () => ({ Service: { Addons: () => Promise.resolve([]) } }));

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
    await act(() => result.current.mutateAsync({ kind: "insert", addon, at: 0 }));
    const configured = { ...addon, url: "https://a/x=1/manifest.json" };
    await act(() =>
      result.current.mutateAsync({ kind: "reconfigure", url: addon.url, addon: configured }),
    );

    expect(account.InstallAddon).toHaveBeenCalledWith(7, addon);
    expect(account.MoveAddon).toHaveBeenCalledWith(7, addon.url, 0);
    expect(account.EnableAddon).toHaveBeenCalledWith(7, addon.url, false);
    expect(account.RemoveAddon).toHaveBeenCalledWith(7, addon.url);
    expect(account.InsertAddon).toHaveBeenCalledWith(7, addon, 0);
    expect(account.ReconfigureAddon).toHaveBeenCalledWith(7, addon.url, configured);
    expect(queryClient.getQueryState(addonsQuery(7).queryKey)?.isInvalidated).toBe(true);
  });
});

describe("addonLink", () => {
  it.each([
    ["https://torrentio.strem.fun/manifest.json", "https://torrentio.strem.fun/manifest.json"],
    ["  https://torrentio.strem.fun/  ", "https://torrentio.strem.fun/manifest.json"],
    ["stremio://torrentio.strem.fun/manifest.json", "https://torrentio.strem.fun/manifest.json"],
    [
      "stremio://torrentio.strem.fun/providers=yts/manifest.json",
      "https://torrentio.strem.fun/providers=yts/manifest.json",
    ],
    ["http://127.0.0.1:7000/manifest.json", "http://127.0.0.1:7000/manifest.json"],
    [
      "https://web.stremio.com/#/addons?addon=https%3A%2F%2Ftorrentio.strem.fun%2Fmanifest.json",
      "https://torrentio.strem.fun/manifest.json",
    ],
  ])("reads %s", (input, want) => {
    expect(addonLink(input)).toBe(want);
  });

  it.each(["", "torrentio", "ftp://a.example/manifest.json", "javascript:alert(1)"])(
    "refuses %j",
    (input) => {
      expect(addonLink(input)).toBeUndefined();
    },
  );

  it("finds the configure page next to the manifest", () => {
    expect(configureUrl("https://aio.example/stremio/manifest.json")).toBe(
      "https://aio.example/stremio/configure",
    );
  });
});

describe("applyAddonEdit", () => {
  const a = { url: "https://a/manifest.json", name: "A", enabled: true };
  const b = { url: "https://b/manifest.json", name: "B", enabled: false };
  const c = { url: "https://c/manifest.json", name: "C", enabled: true };

  it("makes each edit as Go does", () => {
    expect(applyAddonEdit([a, b], { kind: "install", addon: c })).toEqual([a, b, c]);
    expect(applyAddonEdit([a, b], { kind: "insert", addon: c, at: 1 })).toEqual([a, c, b]);
    expect(applyAddonEdit([a, b], { kind: "insert", addon: c, at: 9 })).toEqual([a, b, c]);
    expect(applyAddonEdit([a, b, c], { kind: "move", url: c.url, to: 0 })).toEqual([c, a, b]);
    expect(applyAddonEdit([a, b, c], { kind: "move", url: a.url, to: 9 })).toEqual([b, c, a]);
    expect(applyAddonEdit([a, b], { kind: "remove", url: a.url })).toEqual([b]);
    expect(applyAddonEdit([a, b], { kind: "enable", url: b.url, enabled: true })).toEqual([
      a,
      { ...b, enabled: true },
    ]);
    // Reconfiguring keeps the place and whether it is on.
    const b2 = { url: "https://b/x/manifest.json", name: "B2", enabled: true };
    expect(applyAddonEdit([a, b], { kind: "reconfigure", url: b.url, addon: b2 })).toEqual([
      a,
      { ...b2, enabled: false },
    ]);
  });

  it("leaves the list alone for an edit Go would refuse", () => {
    expect(applyAddonEdit([a], { kind: "install", addon: a })).toEqual([a]);
    expect(applyAddonEdit([a], { kind: "remove", url: c.url })).toEqual([a]);
    expect(applyAddonEdit([a, b], { kind: "reconfigure", url: a.url, addon: b })).toEqual([a, b]);
  });
});
