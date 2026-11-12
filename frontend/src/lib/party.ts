import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent } from "react";

import type { Watching } from "@bindings/playback";
import {
  Service as Party,
  type Chat,
  type Media,
  type Member,
  type Message,
  type Notice,
  type Party as PartyInfo,
  type Preview,
  type Source as PartySource,
  type State,
  type Stream as SharedStream,
} from "@bindings/party";
import type { Source } from "@bindings/streams";
import type { Meta, Stream } from "@/lib/addon-protocol";
import { feature } from "@/lib/features";
import { streamsPath, streamsSearch, type PlayTarget } from "@/lib/playback";

// Watch parties (ADR-0051): watching with friends on Peli or Nuvio's apps,
// each from their own streams, in step. Go (internal/party) runs the party
// and keeps the player in step; this side shows it. State and the chat come
// as party:state and party:chat, each whole, so the queries below are set
// from them; notices (someone paused, joined, left) come as party:notice.

export const stateEvent = "party:state";
export const noticeEvent = "party:notice";
export const chatEvent = "party:chat";

export { Party };
export type { Chat, Media, Member, Message, Notice, PartyInfo, Preview, SharedStream, State };

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

// The party as it is now: undefined until Go first answers.
export function useParty(): State | undefined {
  return useQuery(partyQuery).data;
}

export function usePartyChat(): Chat {
  return useQuery(partyChatQuery).data ?? { messages: [], unread: 0 };
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
    return () => {
      offState();
      offChat();
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

// The code party.MarshalError put in a call's cause.
export function errorCode(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" ? code : undefined;
}

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
  }
  return undefined;
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
