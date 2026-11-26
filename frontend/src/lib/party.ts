import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useCallback, useEffect, useEffectEvent } from "react";

import type { Watching } from "@bindings/playback";
import {
  Service as Party,
  type AccountParty,
  type Activity,
  type ActivityEntry,
  type Chat,
  type Media,
  type Member,
  type Message,
  type Notice,
  type Party as PartyInfo,
  type Preview,
  type Reaction,
  type Source as PartySource,
  type State,
  type Stream as SharedStream,
} from "@bindings/party";
import type { Source } from "@bindings/streams";
import type { Meta, Stream } from "@/lib/addon-protocol";
import { feature } from "@/lib/features";
import { errorCode } from "@/lib/error-code";
import type { PlayTarget } from "@/lib/playback";
import { streamsPath, streamsSearch } from "@/lib/streams-path";

// Watch parties (ADR-0051): watching with friends on Peli or Nuvio's apps,
// each from their own streams, in step. Go (internal/party) runs the party
// and keeps the player in step; this side shows it. State, the chat and the
// activity log come as party:state, party:chat and party:activity, each
// whole, so the queries below are set from them; notices (someone paused,
// joined, left) come as party:notice.

export const stateEvent = "party:state";
export const noticeEvent = "party:notice";
export const chatEvent = "party:chat";
// What happened in the party, in one log: who came and went, who paused,
// skipped or changed the speed, and what it moved on to. The chat shows it
// between the messages.
export const activityEvent = "party:activity";
// One per emoji a member sends, the sender's own included (Mine).
export const reactionEvent = "party:reaction";

// The emoji a member can send, in the order the buttons show them: Go's
// allow-list (party.REACTIONS), so the two can’t drift.
export const REACTIONS = ["😂", "❤️", "🔥", "😮", "😢", "👏", "🎉", "🍿"] as const;

// What each emoji is called to a screen reader: an emoji on its own is read
// as its name by some, as nothing by others.
export const reactionName: Record<(typeof REACTIONS)[number], string> = {
  "😂": "laugh",
  "❤️": "love",
  "🔥": "fire",
  "😮": "wow",
  "😢": "sad",
  "👏": "applause",
  "🎉": "party",
  "🍿": "popcorn",
};

export { Party };
export type {
  AccountParty,
  Activity,
  ActivityEntry,
  Chat,
  Media,
  Member,
  Message,
  Notice,
  PartyInfo,
  Preview,
  Reaction,
  SharedStream,
  State,
};

export const partyQuery = queryOptions({
  queryKey: ["party", "state"],
  queryFn: () => Party.State(),
  // Not bound on iOS (ADR-0055).
  enabled: () => feature("party"),
  staleTime: Infinity,
});

export const partyChatQuery = queryOptions({
  queryKey: ["party", "chat"],
  queryFn: () => Party.Chat(),
  enabled: () => feature("party"),
  staleTime: Infinity,
});

// The party's activity log, newest last, as party:activity carries it whole.
export const partyActivityQuery = queryOptions({
  queryKey: ["party", "activity"],
  queryFn: () => Party.Activity(),
  enabled: () => feature("party"),
  staleTime: Infinity,
});

// The account's live parties, for the Join page (ADR-0067): what this
// account's profiles announced in its synced data, confirmed by Go. It is a
// pull, not a push: it fetches when the page opens and when the window comes
// back, and no faster than every 30 s.
export const accountPartiesQuery = queryOptions({
  queryKey: ["party", "account"],
  queryFn: () => Party.AccountParties(),
  enabled: () => feature("party"),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

// The party as it is now: undefined until Go first answers.
export function useParty(): State | undefined {
  return useQuery(partyQuery).data;
}

// The account's live parties, with the query's own loading state.
export function useAccountParties() {
  const query = useQuery(accountPartiesQuery);
  return { parties: query.data ?? [], pending: query.isPending };
}

export function usePartyChat(): Chat {
  return useQuery(partyChatQuery).data ?? { messages: [], unread: 0 };
}

export function usePartyActivity(): Activity {
  return useQuery(partyActivityQuery).data ?? { entries: [] };
}

// Keeps the party queries in step with Go's events. Mounted once, at the
// root.
export function usePartyEvents(queryClient: QueryClient) {
  useEffect(() => {
    if (!feature("party")) return undefined;
    const offState = Events.On(stateEvent, (event) => {
      queryClient.setQueryData(partyQuery.queryKey, event.data);
    });
    const offChat = Events.On(chatEvent, (event) => {
      queryClient.setQueryData(partyChatQuery.queryKey, event.data);
    });
    const offActivity = Events.On(activityEvent, (event) => {
      queryClient.setQueryData(partyActivityQuery.queryKey, event.data);
    });
    return () => {
      offState();
      offChat();
      offActivity();
    };
  }, [queryClient]);
}

// Calls onNotice for each notice.
export function usePartyNotices(onNotice: (notice: Notice) => void) {
  const handle = useEffectEvent(onNotice);
  useEffect(
    () => (feature("party") ? Events.On(noticeEvent, (event) => handle(event.data)) : undefined),
    [],
  );
}

// Sends an emoji reaction, for the layer that bursts it and the buttons that
// pick it. Nothing bursts here: Go sends the event back, the sender's own
// with Mine, so everyone bursts from the same place.
export function useSendReaction(): (emoji: string) => void {
  return useCallback((emoji: string) => {
    Party.SendReaction(emoji).catch((error: unknown) => {
      // The party ended between the tap and the call: nothing to say.
      if (errorCode(error) === codeNotInParty) return;
      console.error("Couldn’t send a reaction", error);
    });
  }, []);
}

// Calls onReaction for each reaction, its own member's included. The latest
// callback is the one called, as for notices: the layer's burst doesn't
// resubscribe on every render.
export function usePartyReactions(onReaction: (reaction: Reaction) => void) {
  const handle = useEffectEvent(onReaction);
  useEffect(
    () => (feature("party") ? Events.On(reactionEvent, (event) => handle(event.data)) : undefined),
    [],
  );
}

// "ABC DEF".
export function formatCode(code: string): string {
  const clean = normalizeCode(code);
  return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean;
}

// The letters and digits a code has, upper case: no 0, 1, I or O.
export function normalizeCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "");
}

export const codeLength = 6;

// What Copy invite puts on the clipboard. Nuvio's link opens its apps; a
// Peli friend types the code.
export function inviteText(code: string): string {
  return `Join my watch party with code ${formatCode(code)}\nhttps://nuvio.tv/party/${normalizeCode(code)}`;
}

// What a refusal says, by Go's code.
export function partyProblem(code: string | undefined): string {
  switch (code) {
    case "party_not_found":
      return "No watch party has that code.";
    case "party_full":
      return "This watch party is full.";
    case "removed":
    case "not_member":
      return "You can’t join this watch party.";
    case "party_ended":
      return "This watch party has ended.";
    case "rate_limited":
      return "Too many tries. Wait a few minutes and try again.";
    case "unavailable":
      return "Watch parties aren’t available right now.";
    case "sign_in":
      return "Sign in to your Nuvio account to watch together.";
    case "kids_profile":
      return "Kids profiles can’t join watch parties.";
    case "not_host":
      return "Only the host can do that.";
    default:
      return "Couldn’t reach the watch party. Check your connection.";
  }
}

// Go's code for a call made outside a party (party.CodeNotInParty): the
// reaction that arrives after the party ended, mostly.
export const codeNotInParty = "not_in_party";

// What a member is doing, in a few words.
export function memberStatus(member: Member): string {
  if (member.watchingElse && member.status !== "offline") return "Watching something else";
  switch (member.status) {
    case "ready":
      return "Watching";
    case "buffering":
      return "Buffering";
    case "loading":
      return "Loading";
    case "behind":
      return `${duration(member.behindMs)} behind`;
    case "offline":
      return "Offline";
    default:
      return "Choosing a source";
  }
}

// "1:05", "1:02:03", from milliseconds.
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// "A show · S1 E3", or the film's title.
export function mediaLabel(media: Pick<Media, "title" | "season" | "episode">): string {
  if (media.season != null && media.episode != null)
    return `${media.title} · S${media.season} E${media.episode}`;
  return media.title;
}

// What a notice says, or undefined for those shown some other way.
export function noticeText(notice: Notice): string | undefined {
  switch (notice.kind) {
    case "action":
      switch (notice.action) {
        case "paused":
          return `${notice.name} paused`;
        case "resumed":
          return `${notice.name} resumed`;
        case "seeked":
          return `${notice.name} skipped to ${duration(notice.positionMs)}`;
        case "speed":
          return `${notice.name} changed the speed to ${notice.rate}×`;
      }
      return undefined;
    case "joined":
      return `${notice.name} joined the watch party`;
    case "left":
      return `${notice.name} left the watch party`;
    case "ended":
      return "The watch party has ended";
    case "removed":
      return "You were removed from the watch party";
    case "media":
      return notice.media ? `The party is watching ${mediaLabel(notice.media)}` : undefined;
    case "control":
      return notice.hostOnly
        ? "Only the host can control playback now"
        : "Everyone can control playback now";
    case "locked":
      return "Only the host can control playback";
    case "caught_up":
      return "Back in step with the party";
    case "party_gone":
      // A party the Join page listed has ended (ADR-0067).
      return notice.media
        ? `The watch party for ${mediaLabel(notice.media)} has ended`
        : "A watch party has ended";
  }
  return undefined;
}

// One line of the party's activity log: who did what, without the time (the
// chat shows that beside it). "You" for what this device did, and a name
// that didn't come through reads as someone.
export function activityText(entry: ActivityEntry): string {
  const who = entry.mine ? "You" : entry.name || "Someone";
  switch (entry.kind) {
    case "paused":
      return `${who} paused at ${duration(entry.positionMs)}`;
    case "resumed":
      return `${who} resumed at ${duration(entry.positionMs)}`;
    case "seeked":
      return `${who} skipped to ${duration(entry.positionMs)}`;
    case "speed":
      return `${who} changed the speed to ${entry.rate}×`;
    case "joined":
      return `${who} joined`;
    case "left":
      return `${who} left`;
    case "media":
      return entry.title ? `${who} started ${entry.title}` : `${who} started something new`;
    default:
      // A kind this side doesn't know yet: Go may have added one.
      return `${who} did something`;
  }
}

// A row of the chat as it shows: a message, or one line of the log.
export type TimelineItem =
  | { type: "message"; message: Message }
  | { type: "activity"; entry: ActivityEntry };

// The chat and the activity log as one list, in time order. Messages keep
// their own order and are never re-sorted: each entry goes before the first
// message sent after it, and the entries come in the order Go sends them
// (oldest first). A message still sending, or one that failed, is the
// newest thing there is, so it stays at the end, after the log.
export function partyTimeline(messages: Message[], entries: ActivityEntry[]): TimelineItem[] {
  // The messages the log can sit between: the sent ones, in their own order.
  const waiting = messages.filter(
    (message) => message.status !== "sending" && message.status !== "failed",
  );
  const unsent = messages.filter(
    (message) => message.status === "sending" || message.status === "failed",
  );
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    let head = waiting[0];
    while (head && head.sentAt <= entry.at) {
      waiting.shift();
      items.push({ type: "message", message: head });
      head = waiting[0];
    }
    items.push({ type: "activity", entry });
  }
  for (const message of waiting) items.push({ type: "message", message });
  for (const message of unsent) items.push({ type: "message", message });
  return items;
}

// The party's name for what the player plays: from what its progress is
// kept as, the heading, the title's details and the addon's stream.
export function partyMedia(
  watching: Watching,
  heading: { title: string; episode?: string | undefined },
  meta: Meta | undefined,
  stream: Stream | undefined,
): Media {
  const description = (meta?.description ?? "").slice(0, 600);
  return {
    type: watching.contentType,
    id: watching.contentId,
    videoId: watching.videoId === watching.contentId ? "" : watching.videoId,
    season: watching.season ?? null,
    episode: watching.episode ?? null,
    title: watching.name || heading.title,
    episodeTitle: watching.season != null ? (watching.title ?? "") : "",
    description,
    poster: meta?.poster ?? "",
    background: meta?.background ?? "",
    logo: meta?.logo ?? "",
    source: stream ? partySource(stream) : null,
  };
}

// The stream as the party names it, so the others find it in their addons.
export function partySource(stream: Stream): PartySource {
  const hints = stream.behaviorHints;
  return {
    infoHash: stream.infoHash?.toLowerCase() ?? "",
    fileIdx: typeof stream.fileIdx === "number" ? stream.fileIdx : null,
    filename: hints?.filename ?? "",
    videoSize: typeof hints?.videoSize === "number" ? hints.videoSize : 0,
    bingeGroup: hints?.bingeGroup ?? "",
    addonId: "",
    name: (stream.name ?? "").trim(),
  };
}

// The link the host plays, for sharing: Go keeps only one others can open
// (not a torrent's loopback link).
export function sharedStream(source: Source, stream: Stream | undefined): SharedStream {
  return {
    mediaKey: "",
    url: source.url,
    headers: source.headers ?? {},
    responseHeaders: {},
    name: (stream?.name ?? "").trim(),
    description: stream?.description ?? stream?.title ?? "",
    addonName: "",
    addonId: "",
    addonLogo: "",
    filename: stream?.behaviorHints?.filename ?? "",
    videoSize:
      typeof stream?.behaviorHints?.videoSize === "number" ? stream.behaviorHints.videoSize : 0,
    bingeGroup: stream?.behaviorHints?.bingeGroup ?? "",
    sharedBy: "",
  };
}

// Whether stream is the one the party's host plays: the same torrent (and
// file), else the same file name, else the same name from the same addon.
export function matchesPartySource(stream: Stream, source: PartySource | null): boolean {
  if (!source) return false;
  const hash = source.infoHash.trim().toLowerCase();
  const streamHash = stream.infoHash?.toLowerCase();
  if (hash && streamHash) {
    const index = source.fileIdx;
    const streamIndex = typeof stream.fileIdx === "number" ? stream.fileIdx : null;
    return hash === streamHash && (index == null || streamIndex == null || index === streamIndex);
  }
  const file = source.filename.trim().toLowerCase();
  const streamFile = stream.behaviorHints?.filename?.trim().toLowerCase();
  if (file && streamFile) return file === streamFile;
  const name = source.name.trim().toLowerCase();
  return name !== "" && source.addonId !== "" && (stream.name ?? "").trim().toLowerCase() === name;
}

// Whether the party watches what target plays.
export function partyWatches(
  party: PartyInfo | null | undefined,
  type: string,
  id: string,
  video: string,
): boolean {
  if (!party) return false;
  return (
    party.media.type.toLowerCase() === type.toLowerCase() &&
    party.media.id === id &&
    (party.media.videoId || party.media.id) === video
  );
}

// The picker for what the party watches, to watch it with them.
export function partyTarget(media: Media): PlayTarget {
  return {
    type: media.type,
    id: media.id,
    title: media.title,
    ...(media.videoId && { videoId: media.videoId }),
  };
}

export function useWatchWithParty() {
  const navigate = useNavigate();
  return (media: Media, replace = false) => {
    const target = partyTarget(media);
    void navigate({
      to: streamsPath,
      params: { type: target.type, id: target.id },
      search: streamsSearch({ video: target.videoId }),
      state: (state) => ({ ...state, play: target }),
      replace,
    });
  };
}

// Starts and leaves parties, updating the state query at once.
export function usePartyActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: partyQuery.queryKey });
  return {
    create: (media: Media) => Party.Create(media).finally(refresh),
    join: (code: string) => Party.Join(code).finally(refresh),
    leave: () => Party.Leave().finally(refresh),
    end: () => Party.End().finally(refresh),
  };
}

// Outside the player, what happens in the party shows as toasts: who came
// and went, the party moving on (with a way to follow it), and its end. The
// player shows these itself, and members' pauses and seeks only matter
// there.
export function usePartyToasts(onPlayer: () => boolean, add: (toast: PartyToast) => void) {
  const watchWithParty = useWatchWithParty();
  usePartyNotices((notice) => {
    if (onPlayer()) return;
    if (notice.kind === "action" || notice.kind === "locked" || notice.kind === "caught_up") return;
    const title = noticeText(notice);
    if (!title) return;
    const media = notice.media;
    add({
      title,
      type: notice.kind === "removed" ? "warning" : "info",
      ...(notice.kind === "media" &&
        media && { action: { label: "Watch with the party", run: () => watchWithParty(media) } }),
    });
  });
}

export type PartyToast = {
  title: string;
  type: "info" | "warning";
  action?: { label: string; run: () => void };
};

export { errorCode };
