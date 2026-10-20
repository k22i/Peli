import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent, useState } from "react";

import { Service as Account, type ProfileEdit } from "@bindings/account";
import { Service as Store, type Profile } from "@bindings/store";
import { accountQuery, currentProfileQuery } from "@/lib/profile";
import { secrets } from "@/lib/secrets";

// Every profile on this device. None means first run: the welcome screen
// offers to sign in or carry on as a guest.
export const profilesQuery = queryOptions({
  queryKey: ["profiles", "all"],
  queryFn: () => Store.Profiles(),
  staleTime: Number.POSITIVE_INFINITY,
  // A local read: retrying won't help, and the first-run check awaits it on
  // every navigation while the profile menu holds it.
  retry: false,
});

// Sent by internal/account when a refresh finds the session revoked or
// expired. The account's profiles and data stay on this device.
export const sessionEndedEvent = "account:session-ended";

// Resolves to null when there's a keychain to keep a session in, or to what
// to install when there isn't (Linux with no Secret Service). Guest mode
// doesn't need one.
export const keychainQuery = queryOptions({
  queryKey: ["keychain"],
  queryFn: () =>
    secrets.available().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
  staleTime: Number.POSITIVE_INFINITY,
});

// The codes internal/account gives a failed sign-in, in the error's cause.
const signInErrorCodes = [
  "invalid_credentials",
  "rate_limited",
  "unreachable",
  "unavailable",
  "keychain_unavailable",
  "qr_expired",
] as const;
export type SignInErrorCode = (typeof signInErrorCodes)[number];

export function signInErrorCode(error: unknown): SignInErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return signInErrorCodes.find((code) => code === cause.code);
}

// After a new current profile: the first-run check reads the profile list
// before the next page renders, so it has to be fresh before navigating.
async function profileChanged(queryClient: QueryClient, profile: Profile) {
  queryClient.setQueryData(currentProfileQuery.queryKey, profile);
  await queryClient.fetchQuery({ ...profilesQuery, staleTime: 0 });
  await queryClient.invalidateQueries({ queryKey: ["profiles"] });
  await queryClient.invalidateQueries({ queryKey: accountQuery.queryKey });
}

// Signs in to Nuvio. Go keeps the tokens (ADR-0008); what comes back is the
// profile now current, so the app can switch to it.
export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      Account.SignIn(email, password),
    onSuccess: async (profile) => {
      await profileChanged(queryClient, profile);
    },
  });
}

// A QR sign-in's code (#21): Go starts a device login and keeps its secret
// parts; this is what the screen shows. Never cached past the screen, and
// refetched for a new code.
export const qrCodeQuery = queryOptions({
  queryKey: ["qr-sign-in"],
  queryFn: () => Account.StartQRSignIn(),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

// Waits in Go for the phone to approve code, then signs in as useSignIn
// does. Leaving the screen, or a new code, cancels the wait; the code itself
// stays valid until it expires.
export function useQRSignIn(code: string | undefined, onSignedIn: (profile: Profile) => void) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<{ code: string; error: Error }>();
  const signedIn = useEffectEvent(onSignedIn);
  useEffect(() => {
    if (!code) return undefined;
    let live = true;
    const wait = Account.WaitQRSignIn(code);
    void wait.then(
      async (profile) => {
        await profileChanged(queryClient, profile);
        if (live) signedIn(profile);
      },
      (error: unknown) => {
        if (live)
          setFailure({ code, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      live = false;
      void wait.cancel();
    };
  }, [code, queryClient]);
  // Only the current code's failure counts.
  return failure && failure.code === code ? failure.error : undefined;
}

// Carries on without an account, on the local Guest profile: the store
// creates it if there's none. Nothing it does reaches Nuvio (#23).
export function useContinueAsGuest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => Store.SwitchToGuest(),
    onSuccess: async (profile) => {
      await profileChanged(queryClient, profile);
    },
  });
}

// Makes another profile current, from the picker or the profile menu (#24).
// Go remembers it across launches. Everything a profile owns is queried by
// its ID, so Home, Library and settings follow without a restart.
export function useSwitchProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profile: Profile) => {
      await Store.SetCurrentProfile(profile.id);
      return profile;
    },
    onSuccess: async (profile) => {
      await profileChanged(queryClient, profile);
    },
  });
}

// Deletes a profile and everything in it (#95): a Nuvio profile from Nuvio,
// on every device, and the Guest from this one. If it was current, Go makes
// the oldest profile left current.
export function useRemoveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: Profile) => Account.DeleteProfile(profile.id),
    onSuccess: async (_, profile) => {
      for (const queryKey of [
        ["settings", "profile", profile.id],
        ["addons", profile.id],
      ]) {
        queryClient.removeQueries({ queryKey });
      }
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// Nuvio's stock avatars, for the profile editor. The catalog is public but
// online only; the editor carries on without it.
export const avatarsQuery = queryOptions({
  queryKey: ["avatars"],
  queryFn: async () => (await Account.Avatars()) ?? [],
  staleTime: 60 * 60 * 1000,
  retry: false,
});

// Renames a profile and changes its avatar and colour (#95): a Nuvio profile
// in Nuvio, on every device, and the Guest on this one.
export function useEditProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profile, edit }: { profile: Profile; edit: ProfileEdit }) =>
      Account.EditProfile(profile.id, edit),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// Adds a Nuvio profile at the account's lowest free index (#95).
export function useAddProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: ProfileEdit) => Account.AddProfile(edit),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// How many profiles a Nuvio account can have.
export const maxNuvioProfiles = 6;

// The codes internal/account gives a failed profile change (#95). Nothing is
// queued: offline or signed out, the change is refused until the sync module
// (#28) can push it later.
const profileErrorCodes = [
  "unreachable",
  "unavailable",
  "rate_limited",
  "signed_out",
  "profile_not_found",
  "profiles_full",
  "primary_profile",
  "last_profile",
  "invalid_profile",
] as const;

// What to tell the user when changing a profile fails.
export function profileProblem(error: Error): { title: string; description: string } {
  const cause: unknown = error.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? profileErrorCodes.find((c) => c === cause.code)
      : undefined;
  switch (code) {
    case "unreachable":
      return {
        title: "Couldn’t reach Nuvio",
        description:
          "Nuvio profiles change on every device, so this needs a connection. Try again when you’re online.",
      };
    case "unavailable":
    case "rate_limited":
      return { title: "Nuvio isn’t answering", description: "Try again in a moment." };
    case "signed_out":
      return {
        title: "Sign in again to change Nuvio profiles",
        description:
          "Your Nuvio session ended. Nuvio profiles change on every device, so Sinag needs to be signed in.",
      };
    case "profile_not_found":
      return {
        title: "This profile is gone from Nuvio",
        description: "It was deleted on another device.",
      };
    case "profiles_full":
      return {
        title: `All ${maxNuvioProfiles} Nuvio profiles are in use`,
        description: "Delete one to add another.",
      };
    case "primary_profile":
      return {
        title: "The first profile can’t be deleted",
        description: "Other profiles can share its addons, so Nuvio keeps it.",
      };
    case "last_profile":
      return {
        title: "The last profile can’t be deleted",
        description: "A Nuvio account always has a profile.",
      };
    default:
      return { title: "Couldn’t save the profile", description: error.message };
  }
}

// More than one profile on this device: the picker asks who's watching at
// launch and after signing in (#24).
export function needsPicker(profiles: readonly Profile[] | null | undefined): boolean {
  return (profiles?.length ?? 0) > 1;
}

// Signs out of Nuvio. Go deletes the session, the account's profiles with
// their data and the persisted cache (#22); the in-memory cache goes too, so
// nothing of the account is left on screen.
export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => Account.SignOut(),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

// Sends the user to sign in again when Go finds the session has ended.
export function useSessionEndedRedirect() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(
    () =>
      Events.On(sessionEndedEvent, () => {
        void queryClient.invalidateQueries({ queryKey: accountQuery.queryKey });
        void navigate({ to: "/sign-in", search: { reason: "session-ended" } });
      }),
    [queryClient, navigate],
  );
}
