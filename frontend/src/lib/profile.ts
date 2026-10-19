import { queryOptions, useQuery } from "@tanstack/react-query";

import { Service as Store } from "@bindings/store";

export type Profile = {
  // Unset until the store has answered.
  id?: number;
  name: string;
  // Signed in to Nuvio; guests (#23) have nothing to sign out of.
  signedIn: boolean;
};

const guest: Profile = { name: "Guest", signedIn: false };

// The store's oldest profile, or a local Guest profile it creates on first
// launch. A stand-in until guest mode (#23), the picker (#24) and Nuvio
// sign-in (#20) decide which profile is current.
export const currentProfileQuery = queryOptions({
  queryKey: ["profiles", "current"],
  queryFn: () => Store.CurrentProfile(),
  staleTime: Number.POSITIVE_INFINITY,
});

export function useCurrentProfile(): Profile {
  const { data } = useQuery(currentProfileQuery);
  if (!data) return guest;
  // A profile linked to a Nuvio profile only exists after signing in (#20).
  return { id: data.id, name: data.name, signedIn: data.nuvioIndex != null };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
