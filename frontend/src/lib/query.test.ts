import { persistQueryClientSave } from "@tanstack/react-query-persist-client";
import { describe, expect, it } from "vite-plus/test";

import { cacheBuster, createPersistOptions, createQueryClient } from "@/lib/query";

// The storage persister throttles writes; wait for the flush.
const flush = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe("persisted query cache", () => {
  it("saves only successful queries marked meta.persist", async () => {
    const saved = new Map<string, string>();
    const queryClient = createQueryClient();
    const options = createPersistOptions({
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => void saved.set(key, value),
      removeItem: async (key) => void saved.delete(key),
    });

    await queryClient.fetchQuery({
      queryKey: ["addons"],
      queryFn: () => ["cinemeta"],
      meta: { persist: true },
    });
    await queryClient.fetchQuery({ queryKey: ["search", "dune"], queryFn: () => [] });
    await queryClient.fetchQuery({
      queryKey: ["secrets", "nuvio.access-token"],
      queryFn: () => "eyJ.token.sig",
      meta: { persist: true },
    });
    await queryClient
      .fetchQuery({
        queryKey: ["sync"],
        queryFn: () => Promise.reject(new Error("offline")),
        meta: { persist: true },
        retry: false,
      })
      .catch(() => undefined);

    await persistQueryClientSave({ queryClient, ...options });
    await flush();

    const cache: unknown = JSON.parse(saved.get("cove-query-cache") ?? "null");
    expect(cache).toMatchObject({
      buster: cacheBuster,
      clientState: { queries: [{ queryKey: ["addons"], state: { data: ["cinemeta"] } }] },
    });
    expect(cache).toHaveProperty("clientState.queries.length", 1);
    expect(saved.get("cove-query-cache")).not.toContain("eyJ.token.sig");
  });
});
