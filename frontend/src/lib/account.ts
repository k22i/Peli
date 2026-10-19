import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";

import { Service as Account } from "@bindings/account";
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

// Deletes a local profile and everything in it: the picker offers it for the
// Guest (#24). If it was current, Go makes the oldest profile left current.
export function useRemoveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: Profile) => Store.DeleteProfile(profile.id),
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
