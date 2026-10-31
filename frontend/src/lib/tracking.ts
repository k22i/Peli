import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";

import { Service as Tracking, type Connections, type SimklCode } from "@bindings/tracking";

import { invalidateWatching } from "./sync";

// SIMKL and AniList (#71), connected per profile. Go keeps the tokens and
// does the scrobbling, list updates and imports; the webview only shows the
// connections and starts sign-ins (ADR-0042).
export type { Connections, SimklCode };
export { Tracking };

// Sent by internal/tracking when an import added watched marks, and when a
// connection changed by itself (a token stopped working), with the profile.
export const importedEvent = "tracking:imported";
export const changedEvent = "tracking:changed";

export const trackingQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["tracking", profileId],
    queryFn: () => Tracking.Status(profileId),
    staleTime: Number.POSITIVE_INFINITY,
  });

// The codes internal/tracking gives a failed call, in the error's cause.
const trackingErrorCodes = [
  "kids_profile",
  "not_connected",
  "sign_in_expired",
  "no_sign_in",
  "unavailable_here",
  "unreachable",
  "unavailable",
  "rate_limited",
  "read_only",
  "refused",
  "keychain_unavailable",
  "port_in_use",
] as const;
export type TrackingErrorCode = (typeof trackingErrorCodes)[number];

export function trackingErrorCode(error: unknown): TrackingErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return trackingErrorCodes.find((code) => code === cause.code);
}

// What to tell the user when connecting fails.
export function trackingProblem(error: unknown, service: "SIMKL" | "AniList") {
  switch (trackingErrorCode(error)) {
    case "sign_in_expired":
      return { title: "The sign-in timed out", description: "Start again to get a new code." };
    case "unreachable":
      return {
        title: `Can’t reach ${service}`,
        description: "Check your connection and try again.",
      };
    case "unavailable":
    case "rate_limited":
      return { title: `${service} isn’t answering`, description: "Try again in a minute." };
    case "read_only":
      return {
        title: `${service} gave read-only access`,
        description: "Sinag needs to write to scrobble. Connect again and allow it.",
      };
    case "refused":
      return { title: `${service} refused the sign-in`, description: "Connect again." };
    case "port_in_use":
      return {
        title: "Another app is using Sinag’s sign-in port",
        description: "Close other copies of Sinag and try again.",
      };
    case "keychain_unavailable":
      return {
        title: "Couldn’t keep the sign-in in the keychain",
        description: error instanceof Error ? error.message : undefined,
      };
    case "kids_profile":
      return { title: "Kids profiles can’t connect", description: undefined };
    case "unavailable_here":
      return { title: `${service} isn’t available in this build`, description: undefined };
    default:
      return { title: `Couldn’t connect to ${service}`, description: "Try again." };
  }
}

// Saves what a connect or disconnect returned as the profile's
// connections.
function useSetConnections(profileId: number) {
  const queryClient = useQueryClient();
  return (connections: Connections) =>
    queryClient.setQueryData(trackingQuery(profileId).queryKey, connections);
}

export function useDisconnectSimkl(profileId: number) {
  const set = useSetConnections(profileId);
  return useMutation({
    mutationFn: () => Tracking.DisconnectSimkl(profileId),
    onSuccess: set,
  });
}

export function useDisconnectAniList(profileId: number) {
  const set = useSetConnections(profileId);
  return useMutation({
    mutationFn: () => Tracking.DisconnectAniList(profileId),
    onSuccess: set,
  });
}

// Waits for a pending sign-in, then keeps its connections. Go gives up when
// the code expires or the sign-in is cancelled.
export function useWaitSignIn(profileId: number, wait: () => Promise<Connections>) {
  const set = useSetConnections(profileId);
  return useMutation({ mutationFn: wait, onSuccess: set });
}

// Imports now, such as after an import setting is turned on.
export function useImport(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => Tracking.Import(profileId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: trackingQuery(profileId).queryKey }),
  });
}

// Refreshes watched marks after an import, and connections after one
// needs connecting again. Mounted once, at the root.
export function useTrackingEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const offImported = Events.On(importedEvent, (event) => {
      invalidateWatching(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["tracking", event.data] });
    });
    const offChanged = Events.On(changedEvent, (event) => {
      void queryClient.invalidateQueries({ queryKey: ["tracking", event.data] });
    });
    return () => {
      offImported();
      offChanged();
    };
  }, [queryClient]);
}

// Asks Go to import the profile in use when it changes; Go throttles it.
export function useTrackingProfile(profileId: number | undefined) {
  useEffect(() => {
    if (profileId === undefined) return;
    Tracking.ImportSoon(profileId).catch(() => {});
  }, [profileId]);
}
