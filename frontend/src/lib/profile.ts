import { queryOptions, useQuery } from "@tanstack/react-query";

import { Service as Account } from "@bindings/account";
import { Service as Store } from "@bindings/store";

export type Profile = {
  // Unset until the store has answered.
  id?: number;
  name: string;
  // Signed in to Nuvio; guests (#23) have nothing to sign out of.
  signedIn: boolean;
  // A Nuvio profile whose session ended (#22): its data is still here, and
  // signing in again carries on syncing it.
  sessionEnded: boolean;
};

const guest: Profile = { name: "Guest", signedIn: false, sessionEnded: false };

// Whether this device has a Nuvio session, and whether one ended without
// signing out. Go answers from the keychain and the store, so this works
// offline; it never sees a token (ADR-0008).
export const accountQuery = queryOptions({
  queryKey: ["account"],
  queryFn: () => Account.Status(),
  staleTime: Number.POSITIVE_INFINITY,
});

// The profile in use: the first Nuvio profile after signing in (#20), or the
// local Guest profile. The picker (#24) will switch it.
export const currentProfileQuery = queryOptions({
  queryKey: ["profiles", "current"],
  queryFn: () => Store.CurrentProfile(),
  staleTime: Number.POSITIVE_INFINITY,
});

export function useCurrentProfile(): Profile {
  const { data } = useQuery(currentProfileQuery);
  const account = useQuery(accountQuery);
  if (!data) return guest;
  // Only a profile linked to a Nuvio profile has a session to speak of.
  const linked = data.nuvioIndex != null;
  return {
    id: data.id,
    name: data.name,
    signedIn: linked && account.data?.signedIn === true,
    sessionEnded: linked && account.data?.sessionEnded === true,
  };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
