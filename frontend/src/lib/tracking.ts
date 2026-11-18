import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";

import { toastManager } from "@/components/ui/toast";

import {
  Service as Tracking,
  type Connections,
  type SimklCode,
  type TitleRef,
  type TitleTracking,
  type WatchlistItem,
} from "@bindings/tracking";

import type { Meta } from "./addon-protocol";
import { invalidateWatching } from "./sync";
import { trackingNames } from "./title";

// SIMKL and AniList (#71), connected per profile. Go keeps the tokens and
// does the scrobbling, list updates and imports; the webview only shows the
// connections and starts sign-ins (ADR-0042).
export type { Connections, SimklCode, TitleRef, TitleTracking, WatchlistItem };
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
  "not_trackable",
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
        description: "Peli needs to write to scrobble. Connect again and allow it.",
      };
    case "refused":
      return { title: `${service} refused the sign-in`, description: "Connect again." };
    case "port_in_use":
      return {
        title: "Another app is using Peli’s sign-in port",
        description: "Close other copies of Peli and try again.",
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

// Forgets a shared SIMKL grant on this device only, without revoking it, so
// the devices it was copied to stay connected (#133).
export function useForgetSimkl(profileId: number) {
  const set = useSetConnections(profileId);
  return useMutation({
    mutationFn: () => Tracking.ForgetSimkl(profileId),
    onSuccess: set,
  });
}

// The other devices a grant was copied to or from, as one phrase: "Kevin's
// iPhone and Kevin's iPad".
export function sharedWith(names: readonly string[] | null | undefined): string | undefined {
  if (!names?.length) return undefined;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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

// --- lists, ratings and the watchlist ------------------------------------------
//
// What the user does to a title: put it on a list, rate it. Go sends it to
// every connected service that can hold the title (SIMKL, and AniList for
// anime) and keeps what can't be sent yet (ADR-0042). The calls are refused
// on kids profiles with the kids_profile code.

export const trackingStatuses = [
  "planned",
  "watching",
  "completed",
  "paused",
  "dropped",
  "none",
] as const;
export type TrackingStatus = (typeof trackingStatuses)[number];

// What a rating can be, lowest first.
export const ratingValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

// Labels for menus and buttons. "none" takes the title off the lists.
export const trackingStatusLabels: Record<TrackingStatus, string> = {
  planned: "Plan to watch",
  watching: "Watching",
  completed: "Completed",
  paused: "On hold",
  dropped: "Dropped",
  none: "Remove from lists",
};

export type TrackingService = "simkl" | "anilist";
export const trackingServiceNames: Record<TrackingService, string> = {
  simkl: "SIMKL",
  anilist: "AniList",
};

type TitleKind = "movie" | "series";

// The statuses each service keeps, by kind of title. SIMKL has no film that
// is being watched or on hold. AniList only has anime, which Go finds by the
// title's ids, so a title that isn't anime is simply not sent to it.
const statusSupport: Record<TrackingService, Record<TitleKind, readonly TrackingStatus[]>> = {
  simkl: {
    movie: ["planned", "completed", "dropped", "none"],
    series: trackingStatuses,
  },
  anilist: { movie: trackingStatuses, series: trackingStatuses },
};

// The services the profile can send changes to.
export function connectedServices(connections: Connections | undefined): TrackingService[] {
  if (!connections || connections.kids) return [];
  const services: TrackingService[] = [];
  if (connections.simkl && !connections.simkl.needsReconnect) services.push("simkl");
  if (connections.anilist && !connections.anilist.needsReconnect) services.push("anilist");
  return services;
}

// The statuses to offer for a title of this type: those at least one
// connected service keeps, in menu order. Empty when nothing is connected.
export function statusesFor(connections: Connections | undefined, type: string): TrackingStatus[] {
  const kind: TitleKind = type === "movie" ? "movie" : "series";
  const supported = new Set(
    connectedServices(connections).flatMap((service) => statusSupport[service][kind]),
  );
  return trackingStatuses.filter((status) => supported.has(status));
}

// The services that would take the status, for a hint such as "SIMKL, AniList".
export function servicesFor(
  connections: Connections | undefined,
  type: string,
  status: TrackingStatus,
): TrackingService[] {
  const kind: TitleKind = type === "movie" ? "movie" : "series";
  return connectedServices(connections).filter((service) =>
    statusSupport[service][kind].includes(status),
  );
}

// A title as Go wants it: the addon's id and type, and the ids and year
// its meta gave, as the player sends them.
export function titleRef(
  target: { type: string; id: string },
  name: string,
  meta?: Meta,
): TitleRef {
  const { ids, year } = trackingNames(name, meta);
  return {
    type: target.type === "movie" ? "movie" : "series",
    id: target.id,
    name,
    year: year ?? 0,
    ids: ids ?? {},
  };
}

const titleKey = (profileId: number, ref: Pick<TitleRef, "type" | "id">) =>
  ["tracking", profileId, "title", ref.type, ref.id] as const;

// What the connected services say about a title: its list, its rating. Go
// answers "none" when nothing is connected, and fails (with a code) only when
// every service asked did, so a screen can leave it out.
export const titleTrackingQuery = (profileId: number, ref: TitleRef) =>
  queryOptions({
    queryKey: titleKey(profileId, ref),
    queryFn: () => Tracking.TitleStatus(profileId, ref),
    staleTime: 5 * 60_000,
    retry: false,
  });

// The planned titles of every connected service, to open like any addon's.
export const watchlistQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["tracking", profileId, "watchlist"] as const,
    queryFn: () => Tracking.Watchlist(profileId),
    staleTime: 5 * 60_000,
    retry: false,
  });

// Shows the change before Go has sent it, puts it back if Go refuses, and
// otherwise keeps Go's answer. tracking:changed refreshes the rest.
function useOptimisticChange<Value>(
  profileId: number,
  ref: TitleRef,
  send: (value: Value) => Promise<TitleTracking>,
  apply: (current: TitleTracking, value: Value) => TitleTracking,
  // The watchlist as it is once the change is made, when the change moves
  // the title on or off it.
  afterWatchlist?: (list: WatchlistItem[], value: Value) => WatchlistItem[],
) {
  const queryClient = useQueryClient();
  const key = titleKey(profileId, ref);
  const watchlistKey = watchlistQuery(profileId).queryKey;
  return useMutation({
    mutationFn: send,
    onMutate: async (value: Value) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<TitleTracking>(key);
      const listBefore = queryClient.getQueryData<WatchlistItem[]>(watchlistKey);
      const current = before ?? { status: "none", rating: 0, services: [], queued: false };
      queryClient.setQueryData<TitleTracking>(key, apply(current, value));
      if (afterWatchlist && listBefore) {
        queryClient.setQueryData(watchlistKey, afterWatchlist(listBefore, value));
      }
      return { before, listBefore };
    },
    onError: (error, _value, context) => {
      queryClient.setQueryData(key, context?.before);
      if (context?.listBefore) queryClient.setQueryData(watchlistKey, context.listBefore);
      const { title, description } = trackingActionProblem(error);
      toastManager.add({ type: "error", title, ...(description ? { description } : {}) });
    },
    onSuccess: (answer) => {
      queryClient.setQueryData(key, answer);
      void queryClient.invalidateQueries({ queryKey: watchlistKey });
    },
  });
}

// Puts the title on a list ("none" takes it off). Moving a title to
// "planned" or off the lists changes the watchlist too.
export function useSetTrackingStatus(profileId: number, ref: TitleRef) {
  return useOptimisticChange<TrackingStatus>(
    profileId,
    ref,
    (status) => Tracking.SetStatus(profileId, ref, status),
    (current, status) => ({ ...current, status }),
    // Only the planned titles are on the watchlist.
    (list, status) => (status === "planned" ? list : list.filter((item) => item.id !== ref.id)),
  );
}

// Rates the title from 1 to 10, or clears the rating with 0.
export function useSetTrackingRating(profileId: number, ref: TitleRef) {
  return useOptimisticChange<number>(
    profileId,
    ref,
    (rating) => Tracking.SetRating(profileId, ref, rating),
    (current, rating) => ({ ...current, rating }),
  );
}

// What to tell the user when a list or rating change fails.
export function trackingActionProblem(error: unknown) {
  switch (trackingErrorCode(error)) {
    case "not_connected":
      return { title: "Connect SIMKL or AniList first", description: "Do it in Settings." };
    case "not_trackable":
      return {
        title: "Neither service can keep this",
        description: "It has no id they know, or they don’t keep that status for it.",
      };
    case "unreachable":
      return { title: "Can’t reach your lists", description: "Check your connection." };
    case "unavailable":
    case "rate_limited":
      return { title: "Your lists aren’t answering", description: "Try again in a minute." };
    case "read_only":
    case "refused":
      return { title: "Your lists refused the change", description: "Connect again in Settings." };
    case "kids_profile":
      return { title: "Kids profiles don’t keep lists", description: undefined };
    default:
      return { title: "Couldn’t update your lists", description: "Try again." };
  }
}

// Everything a title's menu or page needs to show and change its tracking.
// `statuses` is empty on a kids profile and with nothing connected, which is
// how callers know to show nothing; the title's own state is only asked for
// when there is something to show it in.
export function useTrackingControls(
  profile: { id: number; kids?: boolean | undefined },
  type: string,
  ref: TitleRef,
) {
  const connections = useQuery(trackingQuery(profile.id)).data;
  const statuses = profile.kids ? [] : statusesFor(connections, type);
  const available = statuses.length > 0;
  const state = useQuery({ ...titleTrackingQuery(profile.id, ref), enabled: available });
  const setStatus = useSetTrackingStatus(profile.id, ref);
  const setRating = useSetTrackingRating(profile.id, ref);
  // SIMKL takes a title off its lists through its history removal, which
  // clears the watch history too: ask before sending "none" when SIMKL is
  // among the services that would get it (the ones that hold the title, or
  // every connected one until that's known).
  const warnsOnRemoval = state.data
    ? (state.data.services ?? []).includes("simkl")
    : connectedServices(connections).includes("simkl");
  return { available, statuses, state: state.data, setStatus, setRating, warnsOnRemoval };
}

// A status from a menu's value, or nothing.
export const trackingStatusOf = (value: unknown): TrackingStatus | undefined =>
  trackingStatuses.find((status) => status === value);
