import { persistQueryClientSave } from "@tanstack/react-query-persist-client";
import { describe, expect, it } from "vite-plus/test";

import { cacheBuster, createPersistOptions, createQueryClient } from "@/lib/query";

// The sync storage persister throttles writes; wait for the flush.
const flush = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe("persisted query cache", () => {
  it("saves only successful queries marked meta.persist", async () => {
    const queryClient = createQueryClient();
    const options = createPersistOptions(window.localStorage);

    await queryClient.fetchQuery({
      queryKey: ["addons"],
      queryFn: () => ["cinemeta"],
      meta: { persist: true },
    });
    await queryClient.fetchQuery({ queryKey: ["search", "dune"], queryFn: () => [] });
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

    const saved: unknown = JSON.parse(window.localStorage.getItem("cove-query-cache") ?? "null");
    expect(saved).toMatchObject({
      buster: cacheBuster,
      clientState: { queries: [{ queryKey: ["addons"], state: { data: ["cinemeta"] } }] },
    });
    expect(saved).toHaveProperty("clientState.queries.length", 1);
  });
});
