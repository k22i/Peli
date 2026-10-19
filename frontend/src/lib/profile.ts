export type Profile = {
  name: string;
  // Signed in to Nuvio; guests (#23) have nothing to sign out of.
  signedIn: boolean;
};

const guest: Profile = { name: "Guest", signedIn: false };

// Stand-in until profiles land: guest mode (#23), the picker (#24) and Nuvio
// sign-in (#20).
export function useCurrentProfile(): Profile {
  return guest;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
