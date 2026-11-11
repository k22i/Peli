import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient, type Query } from "@tanstack/react-query";
import type { AsyncStorage, PersistQueryClientOptions } from "@tanstack/react-query-persist-client";

import { Service as Store } from "@bindings/store";

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

// Queries keyed "secrets" hold tokens from the keychain (lib/secrets.ts) and
// are never written to disk, even if marked meta.persist.
export function shouldPersistQuery(query: Query) {
  return (
    query.meta?.persist === true &&
    query.state.status === "success" &&
    query.queryKey[0] !== "secrets"
  );
}

// The persisted cache lives in the Go store's cache bucket (#14), not
// localStorage, so it isn't capped at the webview's ~5 MB.
const storeCache: AsyncStorage = {
  getItem: (key) => Store.CacheGet(key),
  setItem: (key, value) => Store.CacheSet(key, value),
  removeItem: (key) => Store.CacheDelete(key),
};

export function createPersistOptions(
  storage: AsyncStorage = storeCache,
): Omit<PersistQueryClientOptions, "queryClient"> {
  return {
    persister: createAsyncStoragePersister({ storage, key: "peli-query-cache" }),
    maxAge: 7 * day,
    buster: cacheBuster,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
  };
}
