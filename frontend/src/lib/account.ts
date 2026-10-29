import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent, useState } from "react";

import { Service as Account, type ProfileEdit } from "@bindings/account";
import { Service as Store, type KidsScope, type Profile } from "@bindings/store";
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
  "qr_unavailable",
  "parent_pin_required",
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

// Profiles unlocked with their PIN this run (#25). Go owns enforcement; the
// frontend asks for the PIN, unlocks in memory, and a restart asks again.
// Not persisted: lib/query.ts only saves queries with meta.persist. Keyed
// outside the ["profiles"] prefix so profileChanged's invalidateQueries
// ({ queryKey: ["profiles"] }) doesn't reset it on switch.
const unlockedProfilesKey = ["profiles-unlocked"];

export function useUnlockedProfiles(): number[] {
  return useQuery({
    queryKey: unlockedProfilesKey,
    queryFn: () => [] as number[],
    initialData: [] as number[],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }).data;
}

// Sends a profile's PIN to Go, which answers with the retry cooldown on a
// wrong PIN. On success the profile stays unlocked for the rest of the run.
export function useUnlockProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, pin }: { profileId: number; pin: string }) =>
      Account.UnlockProfile(profileId, pin),
    onSuccess: (_, { profileId }) => {
      queryClient.setQueryData<number[]>(unlockedProfilesKey, (ids) =>
        ids?.includes(profileId) ? ids : [...(ids ?? []), profileId],
      );
    },
  });
}

// Checks a kids profile's PIN, the parent PIN (#26). Go then lets the parent
// leave the profile or change things for a couple of minutes. It unlocks the
// profile too, like useUnlockProfile.
export function useApproveParent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, pin }: { profileId: number; pin: string }) =>
      Account.ApproveParent(profileId, pin),
    onSuccess: (_, { profileId }) => {
      queryClient.setQueryData<number[]>(unlockedProfilesKey, (ids) =>
        ids?.includes(profileId) ? ids : [...(ids ?? []), profileId],
      );
    },
  });
}

// What a kids profile may see (#26): the addons its parent allowed. Nothing
// until they choose.
export const kidsScopeQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["profiles", "kids-scope", profileId],
    queryFn: () => Store.KidsScope(profileId),
  });

// Makes a profile a kids profile, or an ordinary one again (#26).
export function useSetKids() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, kids }: { profileId: number; kids: boolean }) =>
      Account.SetKids(profileId, kids),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// Chooses the addons a kids profile may see (#26).
export function useSetKidsScope(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scope: KidsScope) => Account.SetKidsScope(profileId, scope),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: kidsScopeQuery(profileId).queryKey });
    },
  });
}

// Sets or changes a profile's PIN (#25). Go owns the format and enforcement;
// the frontend asks for the new PIN (and the current one when there is one).
// On success the profile is unlocked for the rest of the run, and the profile
// list refreshes so lock badges and the launch gate update.
export function useSetProfilePIN() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      profileId,
      pin,
      currentPin,
    }: {
      profileId: number;
      pin: string;
      currentPin: string;
    }) => Account.SetProfilePIN(profileId, pin, currentPin),
    onSuccess: async (_, { profileId }) => {
      queryClient.setQueryData<number[]>(unlockedProfilesKey, (ids) =>
        ids?.includes(profileId) ? ids : [...(ids ?? []), profileId],
      );
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// Clears a profile's PIN (#25), after the current one. The profile list
// refreshes so the lock badge and the launch gate update.
export function useClearProfilePIN() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, currentPin }: { profileId: number; currentPin: string }) =>
      Account.ClearProfilePIN(profileId, currentPin),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// Makes another profile current, from the picker or the profile menu (#24).
// Go remembers it across launches and enforces the profile's PIN lock (#25).
// Everything a profile owns is queried by its ID, so Home, Library and
// settings follow without a restart.
export function useSwitchProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profile: Profile) => {
      await Account.SwitchProfile(profile.id);
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
  "profile_locked",
  "wrong_pin",
  "invalid_pin",
  "parent_pin_required",
  "kids_need_pin",
  "kids_keep_pin",
  "addon_installed",
  "addon_not_found",
] as const;

// Whether a change was refused for want of the parent PIN (#26): the
// approval lasts two minutes, so a screen opened with it can outlive it.
export function needsParentPin(error: unknown): boolean {
  return signInErrorCode(error) === "parent_pin_required";
}

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
    case "profile_locked":
      return {
        title: "This profile is locked",
        description: "Enter the PIN to use it.",
      };
    case "wrong_pin":
      return {
        title: "Wrong PIN",
        description: "That PIN doesn’t match. Try again.",
      };
    case "invalid_pin":
      return {
        title: "PIN must be 4 digits",
        description: "Use exactly four digits (0–9).",
      };
    case "parent_pin_required":
      return {
        title: "Ask a parent",
        description: "The parent PIN is needed to leave or change a kids profile.",
      };
    case "kids_need_pin":
      return {
        title: "Set a PIN first",
        description: "A kids profile is left with its PIN, so it needs one.",
      };
    case "kids_keep_pin":
      return {
        title: "A kids profile keeps its PIN",
        description: "Turn kids mode off first to clear it.",
      };
    case "addon_installed":
      return {
        title: "Already installed",
        description: "This profile already has an addon at that address.",
      };
    case "addon_not_found":
      return {
        title: "This addon is gone",
        description: "It was removed, maybe on another device.",
      };
    default:
      return { title: "Couldn’t save the profile", description: error.message };
  }
}

// The cooldown, in seconds, Go asks for after too many wrong PINs (#25).
// Zero otherwise, and zero when the error isn't a wrong PIN.
export function pinRetryAfterSeconds(error: unknown): number {
  if (!(error instanceof Error)) return 0;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return 0;
  if (cause.code !== "wrong_pin") return 0;
  if (!("retryAfterSeconds" in cause)) return 0;
  return typeof cause.retryAfterSeconds === "number" ? cause.retryAfterSeconds : 0;
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
