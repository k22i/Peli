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
import { currentProfileQuery, useCurrentProfile } from "@/lib/profile";
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
//
// It only reads the profile the shell has already asked for, never asks
// itself: the nav mounts on the welcome and sign-in screens too, and on first
// run the store makes a Guest when asked for the current profile.
export function useLiveTVAvailable(): boolean {
  const profile = useQuery({ ...currentProfileQuery, enabled: false }).data;
  const id = !profile || profile.kids === true ? 0 : profile.id;
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

// The groups a channel belongs to. iptv-org packs several categories into one
// group-title, separated by semicolons ("Animation;Kids;Religious"), so each
// part is a chip of its own; a channel with no group is in otherGroup alone.
export function groupKeys(channel: Channel): string[] {
  const keys: string[] = [];
  for (const part of channel.group.split(";")) {
    const key = part.trim();
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys : [otherGroup];
}

// A channel's group value: the first of its groupKeys. Playlists pad their
// titles with spaces; a blank group is a group of its own.
export function groupKey(channel: Channel): string {
  return groupKeys(channel)[0] ?? otherGroup;
}

// The groups of these channels, each once, in the order they first appear,
// with otherGroup (if any) last: "Other" is a leftover, not a playlist's
// group, so it reads better after the named ones. Favourites are a chip of
// the page's own, not a group the playlist gave.
export function groupsOf(channels: readonly Channel[]): string[] {
  const groups: string[] = [];
  for (const channel of channels) {
    for (const group of groupKeys(channel)) {
      if (group !== favouritesGroup && !groups.includes(group)) groups.push(group);
    }
  }
  const other = groups.indexOf(otherGroup);
  if (other !== -1) {
    groups.splice(other, 1);
    groups.push(otherGroup);
  }
  return groups;
}

// A group value as a chip names it: "Favourites", "Other" (or "All" for no
// group at all), or else the group as the playlist wrote it.
export function groupLabel(group: string): string {
  if (group === favouritesGroup) return "Favourites";
  if (group === otherGroup) return "Other";
  if (group === "") return "All";
  return group;
}

// Lowercase without accents, so the field finds "Café TV" for "cafe".
const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");

// The channels a group shows, filtered by the field's text: by name, or by
// the channel's number. Favourites come in the profile's own order, not the
// playlist's, and an id the playlist no longer has is skipped.
export function channelsIn(
  channels: readonly Channel[],
  group: string | undefined,
  favourites: readonly string[],
  filter: string,
): Channel[] {
  let chosen: Channel[];
  if (group === undefined || group === "") {
    chosen = [...channels];
  } else if (group === favouritesGroup) {
    // The profile's favourites are a list of ids, so the channels are looked
    // up by id rather than walked in playlist order.
    const byId = new Map<string, Channel>();
    for (const channel of channels) byId.set(channel.id, channel);
    chosen = [];
    for (const id of favourites) {
      const channel = byId.get(id);
      if (channel) chosen.push(channel);
    }
  } else {
    // A channel shows under each of its categories, not just the first.
    chosen = channels.filter((channel) => groupKeys(channel).includes(group));
  }
  const wanted = filter.trim();
  if (wanted === "") return chosen;
  const needle = fold(wanted);
  return chosen.filter(
    (channel) => fold(channel.name).includes(needle) || String(channel.number) === wanted,
  );
}

// The channel step places from currentId in list, wrapping round both ends.
// A list without currentId steps in from the end it comes from, which is
// what channel up and down do after a jump from a search or a guide.
export function neighbourChannel(
  channels: readonly Channel[],
  currentId: string,
  step: 1 | -1,
): Channel | undefined {
  if (channels.length === 0) return undefined;
  const index = channels.findIndex((channel) => channel.id === currentId);
  if (index === -1) return step > 0 ? channels.at(0) : channels.at(-1);
  if (channels.length === 1) return undefined;
  return channels.at((index + step + channels.length) % channels.length);
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
  const length = programme.stop - programme.start;
  if (length <= 0) return 0;
  return Math.min(1, Math.max(0, (now - programme.start) / length));
}

// --- Guide maths (W4) ---------------------------------------------------------

// The guide's columns are half hours.
export const slotMs = 30 * 60_000;

// The span the guide shows: from the half hour before the current one to 36
// hours after the current one starts (Go keeps 2 h back to 36 h ahead). The
// slot before is there so a programme that began earlier has somewhere to
// start, and the axis never moves while it is read.
export function guideRange(now: number): { from: number; to: number } {
  const slot = Math.floor(now / slotMs) * slotMs;
  return { from: slot - slotMs, to: slot + 36 * 60 * 60_000 };
}

// The start of each half hour in [from, to), ascending: the guide's columns.
export function slotsOf(from: number, to: number): number[] {
  const slots: number[] = [];
  for (let slot = Math.ceil(from / slotMs) * slotMs; slot < to; slot += slotMs) slots.push(slot);
  return slots;
}

// Where a time sits on the guide's axis, in px.
export function offsetOf(time: number, from: number, pxPerMinute: number): number {
  return ((time - from) / 60_000) * pxPerMinute;
}

// A programme as the guide draws it, clipped to the range.
export type GuideBlock = {
  programme: Programme;
  left: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
};

// The blocks a channel's row draws, in start order. A programme that only
// partly overlaps the range keeps the visible part and says which end was
// cut. Guides do overlap themselves now and then, so the earlier of two
// overlapping programmes is shortened to end where the later one starts.
export function blocksFor(
  programmes: readonly Programme[],
  from: number,
  to: number,
  pxPerMinute: number,
): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  const overlapping = programmes
    .filter((programme) => programme.stop > from && programme.start < to)
    .toSorted((a, b) => a.start - b.start);
  for (const programme of overlapping) {
    const left = offsetOf(Math.max(programme.start, from), from, pxPerMinute);
    const width = offsetOf(Math.min(programme.stop, to), from, pxPerMinute) - left;
    if (width <= 0) continue;
    let previous = blocks.at(-1);
    while (previous && previous.left + previous.width > left) {
      previous.width = left - previous.left;
      if (previous.width > 0) break;
      // The later one covers it whole.
      blocks.pop();
      previous = blocks.at(-1);
    }
    blocks.push({
      programme,
      left,
      width,
      clippedStart: programme.start < from,
      clippedEnd: programme.stop > to,
    });
  }
  return blocks;
}

// Building a formatter is slow and the axis asks for a label per slot, so
// each locale's is made once. "" is the viewer's own locale.
const clockFormats = new Map<string, Intl.DateTimeFormat>();

// A time as the guide's axis and the rows name it ("21:30", "9:30 PM").
export function clockLabel(ms: number, locale?: string): string {
  const key = locale ?? "";
  let format = clockFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
    clockFormats.set(key, format);
  }
  return format.format(ms);
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
