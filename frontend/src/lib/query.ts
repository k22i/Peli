import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient, type Query } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      // Keep this query's data across restarts. Set it on addon and sync
      // data, not on fast-changing or per-session data.
      persist?: boolean;
    };
  }
}

const day = 24 * 60 * 60 * 1000;

// Bump when the shape of persisted data changes; older caches are dropped.
export const cacheBuster = "1";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Persisted data must outlive the in-memory cache, or it is garbage
        // collected before it is restored.
        gcTime: 7 * day,
        staleTime: 60 * 1000,
      },
    },
  });
}

export function shouldPersistQuery(query: Query) {
  return query.meta?.persist === true && query.state.status === "success";
}

// Where the persisted cache lives. localStorage for now; this can move to the
// SQLite service (#14) without changing callers.
export function createPersistOptions(
  storage: Storage = window.localStorage,
): Omit<PersistQueryClientOptions, "queryClient"> {
  return {
    persister: createSyncStoragePersister({ storage, key: "cove-query-cache" }),
    maxAge: 7 * day,
    buster: cacheBuster,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
  };
}
