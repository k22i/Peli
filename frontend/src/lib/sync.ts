import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";

import { Service as Sync } from "@bindings/syncer";
import type { Surface } from "@bindings/store";

// Sent by internal/syncer after a pull wrote to the local store (#29), with
// the profile and the surfaces it changed.
export const pulledEvent = "sync:pulled";

// The query keys under which each synced surface is read. A screen that shows
// library, progress or watched data keys its query under one of these, so a
// pull refreshes it. Progress feeds "continue watching", and a progress push
// can mark an item watched on the server (the 90 % rule), so watched is
// refreshed with it.
export const surfaceQueryKeys: Partial<Record<Surface, readonly (readonly string[])[]>> = {
  library: [["library"]],
  progress: [["progress"], ["continue-watching"]],
  watched: [["watched"]],
};

export function invalidateSurfaces(queryClient: QueryClient, surfaces: readonly Surface[]) {
  for (const surface of surfaces) {
    for (const queryKey of surfaceQueryKeys[surface] ?? []) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }
}

// Refreshes what's on screen when Go pulls something new from Nuvio. Mounted
// once, at the root.
export function useSyncEvents() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      Events.On(pulledEvent, (event) => {
        invalidateSurfaces(queryClient, event.data.surfaces ?? []);
      }),
    [queryClient],
  );
}

// Asks Go to pull the profile in use as soon as it changes (sign-in, the
// picker, the profile menu). Go pulls on launch, on focus and on an interval
// by itself, throttles repeats, and does nothing for a profile that isn't
// linked to Nuvio, so this is cheap to ask.
export function useSyncProfile(profileId: number | undefined) {
  useEffect(() => {
    if (profileId === undefined) return;
    // Offline or signed out: nothing to show for it, the next pull tries again.
    Sync.Pull().catch(() => {});
  }, [profileId]);
}

// Asks Go to push everything queued now. The player calls it when playback
// pauses, stops or seeks (#30): Go pushes progress at most every 30 s while it
// plays, so this sends the position where it stopped. Pushes also follow every
// change by themselves, so nothing else needs to ask.
export function flushPushes(): Promise<void> {
  // Offline or signed out: Go keeps what failed and retries it.
  return Sync.Flush().catch(() => {});
}
