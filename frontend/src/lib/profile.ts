import { queryOptions, useQuery } from "@tanstack/react-query";

import { Service as Account } from "@bindings/account";
import { Service as Store } from "@bindings/store";

export type Profile = {
  // Unset until the store has answered.
  id?: number;
  name: string;
  // The avatar's image and the colour behind it, from Nuvio (#24).
  avatar?: string | undefined;
  avatarColor?: string | undefined;
  // The local Guest profile (#23), kept apart from any Nuvio account.
  guest: boolean;
  // This device's Nuvio account is signed in, or its session ended (#22)
  // with its data still here. Read from the account rather than the
  // profile, so the Guest offers Sign out while an account is signed in
  // beside it.
  signedIn: boolean;
  sessionEnded: boolean;
  // A PIN-locked profile (#25): pinEnabled means entering it asks for its
  // 4-digit PIN. pinLockedUntil is the cooldown after failed attempts,
  // informational only; the live retry delay comes back from UnlockProfile.
  pinEnabled: boolean;
  pinLockedUntil?: string | null;
  // A kids profile (#26): it sees only the addons its parent allowed, and
  // leaving it asks for its PIN again, the parent PIN.
  kids: boolean;
};

const guest: Profile = {
  name: "Guest",
  guest: true,
  signedIn: false,
  sessionEnded: false,
  pinEnabled: false,
  kids: false,
};

// Whether this device has a Nuvio session, and whether one ended without
// signing out. Go answers from the keychain and the store, so this works
// offline; it never sees a token (ADR-0008).
export const accountQuery = queryOptions({
  queryKey: ["account"],
  queryFn: () => Account.Status(),
  staleTime: Number.POSITIVE_INFINITY,
});

// The profile in use: the one last picked (#24), remembered across
// launches, or else the oldest. On first launch Go makes a Guest profile.
export const currentProfileQuery = queryOptions({
  queryKey: ["profiles", "current"],
  queryFn: () => Store.CurrentProfile(),
  staleTime: Number.POSITIVE_INFINITY,
});

// Screens that come before there is a profile in use. They must not ask for
// the current profile: on first run the store makes a Guest when asked.
export const beforeProfile = new Set(["/welcome", "/sign-in", "/qr-sign-in", "/profiles"]);

// Whether an id names a profile the store has. It numbers profiles from 1, so
// 0 and undefined are both "no profile yet": a screen that renders before
// CurrentProfile answers — a launch, or a webview reload after WebKit kills
// the page — has no profile to ask about and must wait for one. Go refuses a
// call about 0 ("store: profile not found: 0"), so every query that asks the
// store for a profile's things carries `enabled: profileKnown(id)`, and a
// screen that has no id yet passes none along rather than 0.
export const profileKnown = (profileId: number | undefined): boolean =>
  profileId !== undefined && profileId > 0;

export function useCurrentProfile(): Profile {
  const { data } = useQuery(currentProfileQuery);
  const account = useQuery(accountQuery);
  if (!data) return guest;
  return {
    id: data.id,
    name: data.name,
    avatar: data.avatar,
    avatarColor: data.avatarColor,
    guest: data.guest === true,
    signedIn: account.data?.signedIn === true,
    sessionEnded: account.data?.sessionEnded === true,
    pinEnabled: data.pinEnabled === true,
    kids: data.kids === true,
    // Null and absent both mean "not locked out"; keep the field off then.
    ...(typeof data.pinLockedUntil === "string" ? { pinLockedUntil: data.pinLockedUntil } : {}),
  };
}

// Whether a profile needs its PIN before it can be used (#25). Go owns the
// enforcement; this is the frontend's mirror of it.
export function isLocked(profile: Profile): boolean {
  return profile.pinEnabled;
}

// The colours the profile editor offers (#95), lagoon first. Nuvio takes any
// "#rrggbb"; initials on each are black or white, whichever reads better.
export const avatarColors = [
  "#33B5E0",
  "#1E88E5",
  "#7957BD",
  "#D81B60",
  "#E53935",
  "#FB8C00",
  "#FDD835",
  "#43A047",
  "#00897B",
  "#546E7A",
] as const;

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
