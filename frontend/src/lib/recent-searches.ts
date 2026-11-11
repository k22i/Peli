// The last few searches, per profile, on this device. Browser storage is
// enough: it is a convenience, so a profile that loses it just starts a new
// list, and nothing here may break Search when storage is blocked.

export const recentLimit = 8;

const key = (profileId: number) => `sinag.recent-searches.${profileId}`;

export function readRecent(profileId: number): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(profileId)) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === "string").slice(0, recentLimit)
      : [];
  } catch {
    return [];
  }
}

function write(profileId: number, list: readonly string[]) {
  try {
    if (list.length === 0) localStorage.removeItem(key(profileId));
    else localStorage.setItem(key(profileId), JSON.stringify(list));
  } catch {
    // Blocked or full: the list simply isn't kept.
  }
}

// Newest first, once each (a repeat moves up, whatever its case).
export function addRecent(profileId: number, term: string): string[] {
  const list = [
    term,
    ...readRecent(profileId).filter((r) => r.toLowerCase() !== term.toLowerCase()),
  ].slice(0, recentLimit);
  write(profileId, list);
  return list;
}

export function removeRecent(profileId: number, term: string): string[] {
  const list = readRecent(profileId).filter((r) => r !== term);
  write(profileId, list);
  return list;
}

export function clearRecent(profileId: number): string[] {
  write(profileId, []);
  return [];
}
