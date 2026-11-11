import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useTmdbAliases, type TmdbRef } from "./tmdb";

const mocks = vi.hoisted(() => ({ get: vi.fn<() => Promise<string | null>>() }));
vi.mock("@bindings/secrets", () => ({ Service: { Get: mocks.get } }));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.get.mockReset();
});

const ref: TmdbRef = { tmdb: 278, media: "movie" };

const details = {
  title: "The Shawshank Redemption",
  original_title: "The Shawshank Redemption",
  alternative_titles: { titles: [{ iso_3166_1: "ES", title: "Cadena perpetua" }] },
  translations: {
    translations: [
      { iso_639_1: "fr", data: { title: "Les Évadés" } },
      { iso_639_1: "de", data: { title: "Die Verurteilten" } },
    ],
  },
};

function setup(answer: Response | Promise<Response>) {
  const fetch = vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(answer));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { fetch, wrapper };
}

describe("useTmdbAliases", () => {
  it("asks for the alternative titles and translations and gives their names", async () => {
    mocks.get.mockResolvedValue("key");
    const { fetch, wrapper } = setup(new Response(JSON.stringify(details)));
    const { result } = renderHook(() => useTmdbAliases(ref), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current).toEqual(["Cadena perpetua", "Les Évadés", "Die Verurteilten"]);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/3/movie/278");
    expect(url.searchParams.get("append_to_response")).toBe(
      "images,credits,alternative_titles,translations,release_dates,videos,recommendations,similar",
    );
  });

  it("has none, and asks nothing, without a key", async () => {
    mocks.get.mockResolvedValue(null);
    const { fetch, wrapper } = setup(new Response(JSON.stringify(details)));
    const { result } = renderHook(() => useTmdbAliases(ref), { wrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(result.current).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has none for a title TMDB can't be asked about", async () => {
    mocks.get.mockResolvedValue("key");
    const { fetch, wrapper } = setup(new Response(JSON.stringify(details)));
    const { result } = renderHook(() => useTmdbAliases(undefined), { wrapper });
    expect(result.current).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has none when TMDB fails", async () => {
    mocks.get.mockResolvedValue("key");
    const { fetch, wrapper } = setup(new Response("{}", { status: 503 }));
    const { result } = renderHook(() => useTmdbAliases(ref), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
