import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { profileSettingsQuery } from "@/lib/settings";

// Spoiler protection: with the profile's "Hide spoilers" on, an episode not
// yet watched or started shows its still and description blurred, until
// it's revealed. Kids profiles have the same switch. What's revealed stays
// revealed until the app quits, on every screen.

// Whether an episode's still and description stay hidden.
export function hidesSpoilers(
  on: boolean,
  episode: { watched: boolean; started: boolean; revealed: boolean },
): boolean {
  return on && !episode.watched && !episode.started && !episode.revealed;
}

const revealed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Reveals an episode, by video id, everywhere it shows.
export function revealSpoiler(id: string) {
  if (revealed.has(id)) return;
  revealed.add(id);
  version += 1;
  for (const listener of listeners) listener();
}

export const isRevealed = (id: string) => revealed.has(id);

// For tests: everything hidden again.
export function resetRevealed() {
  revealed.clear();
  version += 1;
  for (const listener of listeners) listener();
}

// The profile's switch, and whether an episode is hidden given whether it's
// watched or started. `hidden` re-renders its callers as episodes are revealed.
export function useSpoilers(profileId: number | undefined) {
  const settings = useQuery({
    ...profileSettingsQuery(profileId ?? 0),
    enabled: profileId !== undefined,
  }).data;
  const on = profileId !== undefined && settings?.hideSpoilers === true;
  const seen = useSyncExternalStore(subscribe, () => version);
  const hidden = useCallback(
    (id: string, watched: boolean, started: boolean) =>
      hidesSpoilers(on, { watched, started, revealed: seen >= 0 && revealed.has(id) }),
    [on, seen],
  );
  return { on, hidden, reveal: revealSpoiler };
}
