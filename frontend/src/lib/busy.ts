import { AddonError, isBuiltinAddon } from "@/lib/addon-protocol";
import { isIOS } from "@/lib/platform";

// AniList busy (#128): Peli's AniList addon answers 503 while AniList's
// rate limit runs (internal/anilistaddon). On iOS a catalog that gets it
// tries again by itself, waiting longer each time, and the grid says so
// instead of showing a dead error. The desktop is unchanged.

// Tries after the first, and the waits between them: 4, 8, 16, 32, 60, 60 s.
export const busyRetries = 6;
export const busyDelay = (failures: number) =>
  Math.min(4000 * 2 ** Math.max(failures - 1, 0), 60_000);

// Whether error is a built-in addon's "busy".
export function isBusy(addonUrl: string, error: unknown): boolean {
  return isIOS() && isBuiltinAddon(addonUrl) && error instanceof AddonError && error.status === 503;
}

// TanStack Query's retry and retryDelay for a catalog of addonUrl: busy
// answers as above, anything else once, as before (TanStack's own delay).
export function busyRetry(addonUrl: string) {
  return {
    retry: (failures: number, error: unknown) =>
      isBusy(addonUrl, error) ? failures < busyRetries : failures < 1,
    retryDelay: (failures: number, error: unknown) =>
      isBusy(addonUrl, error) ? busyDelay(failures) : Math.min(1000 * 2 ** failures, 30_000),
  };
}
