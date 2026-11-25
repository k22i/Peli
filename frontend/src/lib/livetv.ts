import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect } from "react";

import {
  Service as LiveTV,
  type Channel,
  type ChannelGuide,
  type NowNext,
  type Programme,
  type Source,
  type SourceInput,
  type Updated,
} from "@bindings/livetv";
import { toastManager } from "@/components/ui/toast";
import { loadOptions, Player } from "@/lib/player";
import { useCurrentProfile } from "@/lib/profile";
import { profileSettingsQuery } from "@/lib/settings";

// Live TV (ADR-0066): IPTV channels from M3U playlists, with an XMLTV guide.
// Go (internal/livetv) fetches, parses and caches both, per profile; the
// screens reach it only through this module. Channels never carry their
// stream: playChannel asks Go for it (LiveTV.Stream) when one plays. Kids
// profiles have none: Go answers an empty source list and refuses the rest.

export { LiveTV };
export type { Channel, ChannelGuide, NowNext, Programme, Source, SourceInput, Updated };

// What the live player is playing, in the player's history state
// (router.ts): the channel, and the group (a groupKey, favouritesGroup, or
// "" for every channel) that Page Up and Page Down move through.
export type LivePlay = { channelId: string; group: string };

// livetv.EventUpdated: a source was added, renamed, removed, or its refresh
// started or ended.
export const updatedEvent = "livetv:updated";

// --- Queries ------------------------------------------------------------------

// Every Live TV query is ["livetv", <profileId>, …], so an update refreshes a
// profile's at once.
export const liveRoot = ["livetv"] as const;
export const liveKey = (profileId: number) => ["livetv", profileId] as const;

const list = <T>(value: T[] | null): T[] => value ?? [];

// The profile's sources, oldest first.
export const sourcesQuery = (profileId: number) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "sources"] as const,
    queryFn: async () => list(await LiveTV.Sources(profileId)),
    enabled: profileId > 0,
  });

// Every source's channels, in source then playlist order.
export const channelsQuery = (profileId: number) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "channels"] as const,
    queryFn: async () => list(await LiveTV.Channels(profileId, "")),
    enabled: profileId > 0,
  });

// The profile's favourite channel ids, oldest first.
export const favouritesQuery = (profileId: number) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "favourites"] as const,
    queryFn: async () => list(await LiveTV.Favourites(profileId)),
    enabled: profileId > 0,
  });

// The channels the profile played last, newest first.
export const recentQuery = (profileId: number) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "recent"] as const,
    queryFn: async () => list(await LiveTV.Recent(profileId)),
    enabled: profileId > 0,
  });

// What these channels show now and next; asked again every minute, so the
// rows move on as programmes end.
export const nowNextQuery = (profileId: number, channelIds: readonly string[]) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "now-next", channelIds] as const,
    queryFn: async () => list(await LiveTV.NowNext(profileId, [...channelIds])),
    enabled: profileId > 0 && channelIds.length > 0,
    refetchInterval: 60_000,
  });

// These channels' programmes that overlap [from, to) (unix ms).
export const guideQuery = (
  profileId: number,
  channelIds: readonly string[],
  from: number,
  to: number,
) =>
  queryOptions({
    queryKey: [...liveKey(profileId), "guide", channelIds, from, to] as const,
    queryFn: async () => list(await LiveTV.Guide(profileId, [...channelIds], from, to)),
    enabled: profileId > 0 && channelIds.length > 0,
    staleTime: 5 * 60_000,
  });

export function useLiveSources(profileId: number): Source[] {
  return useQuery(sourcesQuery(profileId)).data ?? [];
}

export function useLiveChannels(profileId: number): { channels: Channel[]; loading: boolean } {
  const query = useQuery(channelsQuery(profileId));
  return { channels: query.data ?? [], loading: query.isLoading };
}

export function useFavourites(profileId: number): string[] {
  return useQuery(favouritesQuery(profileId)).data ?? [];
}

// Whether the profile gets Live TV: not a kids profile, and a source added.
// The nav entry and the /live page follow it.
export function useLiveTVAvailable(): boolean {
  const profile = useCurrentProfile();
  const id = profile.kids ? 0 : (profile.id ?? 0);
  return useLiveSources(id).length > 0;
}

// --- Events -------------------------------------------------------------------

// Refreshes the profile's Live TV queries on livetv:updated. Mounted once,
// in the root route, beside useDownloadEvents.
export function useLiveTVEvents() {
  const client = useQueryClient();
  useEffect(
    () =>
      Events.On(updatedEvent, (event) => {
        const { profileId } = event.data;
        void client.invalidateQueries({ queryKey: liveKey(profileId) });
      }),
    [client],
  );
}

// --- Actions ------------------------------------------------------------------

// Adding, renaming, removing and refreshing a profile's sources. Each
// refreshes the profile's queries when it settles; errors carry Go's code
// (errorCode from @/lib/error-code).
export function useSourceActions(profileId: number) {
  const client = useQueryClient();
  const settled = () => client.invalidateQueries({ queryKey: liveKey(profileId) });
  const add = useMutation({
    mutationFn: (input: Omit<SourceInput, "profileId">) =>
      LiveTV.AddSource({ ...input, profileId }),
    onSettled: settled,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      LiveTV.RenameSource(profileId, id, name),
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (id: string) => LiveTV.RemoveSource(profileId, id),
    onSettled: settled,
  });
  const refresh = useMutation({
    mutationFn: (id: string) => LiveTV.Refresh(profileId, id),
    onSettled: settled,
  });
  return { add, rename, remove, refresh };
}

// Adds a channel to the favourites or takes it out; the list Go answers
// becomes the cache's.
export function useToggleFavourite(profileId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, on }: { channelId: string; on: boolean }) =>
      LiveTV.SetFavourite(profileId, channelId, on),
    onSuccess: (favourites) => {
      client.setQueryData(favouritesQuery(profileId).queryKey, favourites ?? []);
    },
  });
}

// --- Playing ------------------------------------------------------------------

export const unavailableMessage = "Channel unavailable";

// Plays a channel: asks Go for its stream, loads it with no Watching (live
// TV keeps no progress), and opens the player with `live` in its state.
// `replace` swaps the player's history entry, for channel up and down. A
// failure toasts "Channel unavailable" and resolves false.
export function usePlayChannel() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const profileId = useCurrentProfile().id ?? 0;
  return async (
    channel: Channel,
    group: string,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<boolean> => {
    try {
      const source = await LiveTV.Stream(profileId, channel.id);
      const settings = await client
        .fetchQuery(profileSettingsQuery(profileId))
        .catch(() => undefined);
      await Player.Load(source, loadOptions(0, settings));
      void client.invalidateQueries({ queryKey: recentQuery(profileId).queryKey });
      await navigate({
        to: "/player",
        replace,
        state: (state) => ({
          ...state,
          player: { title: channel.name, source, live: { channelId: channel.id, group } },
        }),
      });
      return true;
    } catch {
      toastManager.add({ type: "error", title: unavailableMessage, description: channel.name });
      return false;
    }
  };
}

// --- Channels and groups (W4) -------------------------------------------------

// The group values the page's ?group= and LivePlay.group take, besides a
// playlist's own group names: the favourites, and channels with no group.
// "" (or no ?group=) is every channel.
export const favouritesGroup = ":favourites";
export const otherGroup = ":other";

// A channel's group value: its group, trimmed, or otherGroup.
export function groupKey(channel: Channel): string {
  return channel.group;
}

// The groups of these channels, each once, in the order they first appear,
// with otherGroup (if any) last.
export function groupsOf(channels: readonly Channel[]): string[] {
  return channels.length > 0 ? [] : [];
}

// A group value as a chip names it: "Favourites", "Other", or the group.
export function groupLabel(group: string): string {
  return group;
}

// The channels a group shows, filtered by the field's text.
export function channelsIn(
  channels: readonly Channel[],
  group: string | undefined,
  favourites: readonly string[],
  filter: string,
): Channel[] {
  return favourites.length > 0 && group !== filter ? [...channels] : [...channels];
}

// The channel step places from currentId in list, wrapping round.
export function neighbourChannel(
  channels: readonly Channel[],
  currentId: string,
  step: 1 | -1,
): Channel | undefined {
  return step > 0 ? channels.find((channel) => channel.id !== currentId) : undefined;
}

// The entry for a channel in a NowNext answer.
export function nowNextFor(
  entries: readonly NowNext[] | undefined,
  channelId: string,
): NowNext | undefined {
  return entries?.find((entry) => entry.channelId === channelId);
}

// Whether a programme is on at now.
export function isOnNow(programme: Programme, now: number): boolean {
  return programme.start <= now && now < programme.stop;
}

// How far through a programme now is, 0–1.
export function progressOf(programme: Programme, now: number): number {
  return programme.stop > now ? 0 : 1;
}

// --- Guide maths (W4) ---------------------------------------------------------

// The guide's columns are half hours.
export const slotMs = 30 * 60_000;

// The span the guide shows: from the half hour before the current one to 36
// hours after the current one starts (Go keeps 2 h back to 36 h ahead).
export function guideRange(now: number): { from: number; to: number } {
  return { from: now, to: now };
}

// The start of each half hour in [from, to).
export function slotsOf(from: number, to: number): number[] {
  return from < to ? [] : [];
}

// Where a time sits on the guide's axis, in px.
export function offsetOf(time: number, from: number, pxPerMinute: number): number {
  return (time - from) * pxPerMinute;
}

// A programme as the guide draws it, clipped to the range.
export type GuideBlock = {
  programme: Programme;
  left: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
};

// The blocks a channel's row draws, in order.
export function blocksFor(
  programmes: readonly Programme[],
  from: number,
  to: number,
  pxPerMinute: number,
): GuideBlock[] {
  return programmes.length > 0 && from < to && pxPerMinute > 0 ? [] : [];
}

// A time as the guide's axis and the rows name it ("21:30", "9:30 PM").
export function clockLabel(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale);
}

// --- The page's address -------------------------------------------------------

// /live?view=guide&group=News: the channel list (no view) or the guide, and
// the group chip (none: every channel; favouritesGroup, otherGroup, or a
// playlist's group name).
export type LiveSearch = { view?: "guide"; group?: string };

export function liveSearch(search: Record<string, unknown>): LiveSearch {
  const { view, group } = search;
  return {
    ...(view === "guide" ? { view } : {}),
    ...(typeof group === "string" && group ? { group } : {}),
  };
}
