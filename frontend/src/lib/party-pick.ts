import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import type { Source as PartySource } from "@bindings/party";
import type { Source } from "@bindings/streams";
import { useStreamChoices } from "@/components/streams/stream-choices";
import type { ContentType, Meta, Stream } from "@/lib/addon-protocol";
import {
  matchesPartySource,
  Party,
  partyWatches,
  type Media,
  type PartyInfo,
  type SharedStream,
} from "@/lib/party";
import { loadOptions, Player } from "@/lib/player";
import { playerState } from "@/lib/playback";
import { parseStream, type Candidate } from "@/lib/ranking";
import { attempts, resolvePick, sameStream, type Attempt } from "@/lib/resolve";
import { subtitleTarget } from "@/lib/subtitles";
import { playerHeading, watchingFor } from "@/lib/title";
import { isIOS } from "@/lib/platform";
import type { ProfileSettings } from "@/lib/settings";

// A guest never chooses a stream (ADR-0051): Peli picks it from the host's.
// One chooser serves joining, the party moving on and the host switching
// streams. The guest's own remembered source is never touched and nothing
// resolves ahead of time: an auto-pick is the party's, not the guest's habit.

export type PartyPickReason = "match" | "shared" | "closest" | "top";

// One thing to try, in order: the guest's own copy of the host's stream, the
// host's shared link (it isn't a Candidate: its link plays as it is), then
// the rest.
export type PartyStep =
  | { kind: "candidate"; candidate: Candidate; reason: PartyPickReason }
  | { kind: "shared"; shared: SharedStream; reason: "shared" };

const hasMatch = (candidate: Candidate, source: PartySource | null) =>
  attempts(candidate).some(({ stream }) => matchesPartySource(stream, source));

// The host's stream as an addon's, for the ranking's parser to read.
function hostStream(source: PartySource): Stream {
  const hints = {
    ...(source.filename && { filename: source.filename }),
    ...(source.videoSize > 0 && { videoSize: source.videoSize }),
  };
  return { name: source.name, ...(Object.keys(hints).length > 0 && { behaviorHints: hints }) };
}

const sizeOf = (candidate: Candidate): number | null => {
  const hinted = candidate.stream.behaviorHints?.videoSize;
  return candidate.parsed.sizeBytes ?? (typeof hinted === "number" && hinted > 0 ? hinted : null);
};

// The candidates nearest the host's stream first: the same resolution, then
// the same source (WEB-DL, BluRay…) and release group, then the nearest
// size. Ties keep the order given, the ranking's. `similar` is whether the
// first has anything in common with it.
export function closestToHost(
  candidates: readonly Candidate[],
  source: PartySource | null,
): { ordered: Candidate[]; similar: boolean } {
  if (!source) return { ordered: [...candidates], similar: false };
  const host = parseStream(hostStream(source));
  const hostSize = source.videoSize > 0 ? source.videoSize : host.sizeBytes;
  const hostGroup = host.group?.toLowerCase() ?? null;
  const measure = (candidate: Candidate) => {
    const { parsed } = candidate;
    const resolution = host.resolution !== null && parsed.resolution === host.resolution ? 1 : 0;
    const group = hostGroup !== null && parsed.group?.toLowerCase() === hostGroup ? 1 : 0;
    const origin =
      host.source !== null && host.source !== "other" && parsed.source === host.source ? 1 : 0;
    const size = sizeOf(candidate);
    const gap =
      hostSize !== null && hostSize > 0 && size !== null ? Math.abs(size - hostSize) : Infinity;
    return { resolution, likeness: group + origin, gap };
  };
  const measured = candidates
    .map((candidate, index) => ({ candidate, index, ...measure(candidate) }))
    .toSorted(
      (a, b) =>
        b.resolution - a.resolution ||
        b.likeness - a.likeness ||
        (a.gap === b.gap ? 0 : a.gap < b.gap ? -1 : 1) ||
        a.index - b.index,
    );
  const first = measured[0];
  return {
    ordered: measured.map(({ candidate }) => candidate),
    similar: !!first && (first.resolution > 0 || first.likeness > 0),
  };
}

// The order a guest tries things in:
//   1. their own streams that are the host's (matchesPartySource),
//   2. the host's shared link, if they share it,
//   3. the rest, closest to the host's stream first,
//   4. which is the guest's own ranking when nothing is alike.
// `candidates` come in the guest's ranking order, the top pick first.
export function partyPlan(candidates: readonly Candidate[], party: PartyInfo): PartyStep[] {
  const source = party.media.source;
  const exact = candidates.filter((candidate) => hasMatch(candidate, source));
  const rest = candidates.filter((candidate) => !exact.includes(candidate));
  const { ordered, similar } = closestToHost(rest, source);
  const restReason: PartyPickReason = similar ? "closest" : "top";
  return [
    ...exact.map((candidate): PartyStep => ({ kind: "candidate", candidate, reason: "match" })),
    ...(party.shared ? [{ kind: "shared", shared: party.shared, reason: "shared" } as const] : []),
    ...ordered.map((candidate): PartyStep => ({
      kind: "candidate",
      candidate,
      reason: restReason,
    })),
  ];
}

// The candidates in that order, and why the first step comes first: with a
// shared link in front (`reason` "shared"), `ordered` is what follows it.
export function orderForParty(
  candidates: Candidate[],
  party: PartyInfo,
): { ordered: Candidate[]; reason: PartyPickReason; exact: boolean } {
  const steps = partyPlan(candidates, party);
  return {
    ordered: steps.flatMap((step) => (step.kind === "candidate" ? [step.candidate] : [])),
    reason: steps[0]?.reason ?? "top",
    exact: steps[0]?.reason === "match",
  };
}

// Whether `party` makes this user a guest: in one, not hosting it, and, when
// `media` is given, watching that (the same type, id and video).
export function isPartyGuest(party: PartyInfo | null | undefined, media?: Media): boolean {
  if (!party || party.isHost) return false;
  if (!media) return true;
  return partyWatches(party, media.type, media.id, media.videoId || media.id);
}

// The host's shared link as the stream and Source the player loads.
export function sharedPlayable(shared: SharedStream): { stream: Stream; source: Source } {
  const stream: Stream = {
    name: shared.name,
    url: shared.url,
    ...(shared.filename && { behaviorHints: { filename: shared.filename } }),
  };
  const source: Source = {
    url: shared.url,
    origin: shared.url,
    headers: shared.headers ?? {},
    userAgent: "",
    contentType: "",
    size: shared.videoSize,
  };
  return { stream, source };
}

type Navigate = ReturnType<typeof useNavigate>;

type Playing = {
  profileId: number;
  type: ContentType;
  id: string;
  video: string;
  title: string;
  meta: Meta | undefined;
  settings: ProfileSettings | undefined;
};

// Loads `source` in the player at `start` and opens /player, as the picker
// does for a pick.
async function openPlayer(
  navigate: Navigate,
  playing: Playing,
  {
    source,
    stream,
    start,
    addon,
  }: { source: Source; stream: Stream; start: number; addon: string },
) {
  const { profileId, type, id, video, title, meta, settings } = playing;
  const watching = watchingFor(profileId, { type, id, title, videoId: video }, meta, []);
  await Player.Load(source, loadOptions(start, settings, [], watching));
  void navigate({
    to: "/player",
    // iOS: the player takes the picker's place, so Back and close land on
    // the title.
    replace: isIOS(),
    state: (state) => ({
      ...state,
      player: playerState({
        heading: playerHeading(meta, video, title),
        source,
        watching,
        start,
        stream,
        subtitles: subtitleTarget(type, video, stream, addon),
      }),
    }),
  });
}

// Plays the host's shared link, starting where the party is. Rejects when
// the player can't open it: the caller says so.
export async function playSharedStream({
  navigate,
  shared,
  media,
  ...playing
}: Playing & { navigate: Navigate; shared: SharedStream; media: Media }): Promise<void> {
  const at = await Party.StartAt(media).catch(() => -1);
  const { stream, source } = sharedPlayable(shared);
  await openPlayer(navigate, playing, {
    source,
    stream,
    start: Math.max(0, at),
    addon: shared.addonName,
  });
}

export type PartyPicked =
  | {
      same?: false;
      candidate?: Candidate;
      attempt: Attempt;
      source: Source;
      start: number;
    }
  // The chooser landed on what plays already: nothing was resolved, so
  // there's no Source.
  | { same: true; candidate?: Candidate; attempt: Attempt; source?: undefined; start: number };

export type PartyPick = {
  status: "searching" | "opening" | "failed" | "done";
  reason?: PartyPickReason;
  hostName: string;
  picked?: PartyPicked;
  retry: () => void;
};

// How long to wait for the other addons once the first has answered.
export const waitAfterFirst = 10_000;

type Outcome = {
  cycle: string;
  status: "failed" | "done";
  reason?: PartyPickReason;
  picked?: PartyPicked;
};

// Picks for a guest, and opens the player with it (`open: false` returns the
// pick instead, for the player's own switch). Starts once one of the guest's
// streams is the host's, or once every addon has answered, or ten seconds
// after the first has: whichever comes first. Restarts, aborting what it
// had in flight, when the host's stream changes. `current` is the stream
// playing now: when the chooser lands on it, nothing resolves.
export function usePartyAutoPick({
  profileId,
  type,
  id,
  video,
  title,
  party,
  enabled,
  open = true,
  current,
  onPicked,
}: {
  profileId: number;
  type: string;
  id: string;
  video: string;
  title: string;
  party: PartyInfo | null;
  enabled: boolean;
  open?: boolean;
  current?: Stream | undefined;
  onPicked?: (picked: PartyPicked) => void;
}): PartyPick {
  const navigate = useNavigate();
  const choices = useStreamChoices(profileId, type, id, video, title);
  const [attempt, setAttempt] = useState(0);
  const active = enabled && !!party && isPartyGuest(party) && partyWatches(party, type, id, video);
  // One run per host stream and per retry.
  const cycle = active && party ? `${attempt}|${JSON.stringify(party.media.source)}` : null;
  const [latched, setLatched] = useState<string | null>(null);
  const [waited, setWaited] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const candidates = flatten(choices.ranked);
  const source = party?.media.source ?? null;
  const matched = candidates.some((candidate) => hasMatch(candidate, source));
  // Streams reach the ranking a step after they reach the picker (the feed is
  // an effect, and the engine answers a microtask later), so for a render or
  // two a source can have streams the ranked view doesn't hold yet. Starting
  // then would pick from an empty list and fail the guest for nothing, so the
  // chooser waits for the ranking — unless nothing at all was handed on to it
  // (no addon has streams, or none it can play), which is a real failure and
  // is answered by `waitAfterFirst` below.
  const handed = choices.sources.some((entry) => (entry.streams?.length ?? 0) > 0);
  const caughtUp = !handed || choices.ranked.total > 0;
  const everyone =
    caughtUp &&
    (choices.answered ||
      (!choices.loading &&
        choices.sources.length > 0 &&
        choices.sources.every((entry) => entry.status !== "pending")));
  const anyAnswered = choices.sources.some((entry) => entry.status !== "pending");

  // State keyed on the cycle is adjusted while rendering, not in an effect:
  // a disabled chooser forgets everything, and a cycle latches once its
  // start condition holds (it stays started if the ranking moves on).
  if (!cycle && (latched !== null || waited !== null || outcome !== null)) {
    setLatched(null);
    setWaited(null);
    setOutcome(null);
  }
  if (cycle && latched !== cycle && (matched || everyone || waited === cycle)) {
    setLatched(cycle);
  }

  useEffect(() => {
    if (!cycle || !anyAnswered || latched === cycle) return undefined;
    const timer = setTimeout(() => setWaited(cycle), waitAfterFirst);
    return () => clearTimeout(timer);
  }, [cycle, anyAnswered, latched]);

  const go = cycle !== null && latched === cycle;

  const run = useEffectEvent(async (signal: AbortSignal, forCycle: string) => {
    if (!party) return;
    const finish = (next: Omit<Outcome, "cycle">) => {
      if (signal.aborted) return;
      setOutcome({ cycle: forCycle, ...next });
      if (next.picked) onPicked?.(next.picked);
    };
    const steps = partyPlan(candidates, party);
    const playing: Playing = {
      profileId,
      type,
      id,
      video,
      title,
      meta: choices.meta,
      settings: choices.settings,
    };
    for (const step of steps) {
      if (signal.aborted) return;
      const mine =
        step.kind === "candidate"
          ? attempts(step.candidate)
          : [{ source: "", stream: sharedPlayable(step.shared).stream }];
      if (current && mine.some((entry) => sameStream(entry.stream, current))) {
        finish({
          status: "done",
          reason: step.reason,
          picked: {
            same: true,
            ...(step.kind === "candidate" && { candidate: step.candidate }),
            attempt: mine[0]!,
            start: 0,
          },
        });
        return;
      }
      let resolved: { source: Source; attempt: Attempt };
      try {
        const resolving =
          step.kind === "candidate"
            ? resolvePick(step.candidate, { refresh: choices.refresh, signal })
            : Promise.resolve(sharedPlayableOf(step.shared));
        // One at a time: each resolve can make a debrid service start a
        // download.
        // oxlint-disable-next-line no-await-in-loop
        resolved = await resolving;
      } catch {
        if (signal.aborted) return;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const at = await Party.StartAt(party.media).catch(() => -1);
      if (signal.aborted) return;
      const start = Math.max(0, at);
      const picked: PartyPicked = {
        ...(step.kind === "candidate" && { candidate: step.candidate }),
        attempt: resolved.attempt,
        source: resolved.source,
        start,
      };
      if (open) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await openPlayer(navigate, playing, {
            source: resolved.source,
            stream: resolved.attempt.stream,
            start,
            addon:
              step.kind === "shared"
                ? step.shared.addonName
                : (choices.names.get(resolved.attempt.source) ?? ""),
          });
        } catch {
          finish({ status: "failed" });
          return;
        }
        if (signal.aborted) return;
      }
      finish({ status: "done", reason: step.reason, picked });
      return;
    }
    finish({ status: "failed" });
  });

  useEffect(() => {
    if (!go || !cycle) return undefined;
    const controller = new AbortController();
    void run(controller.signal, cycle);
    return () => controller.abort();
  }, [go, cycle]);

  const mine = outcome && outcome.cycle === cycle ? outcome : null;
  const hostName = party?.members?.find((member) => member.host)?.name || "the host";
  return {
    status: mine ? mine.status : go ? "opening" : "searching",
    ...(mine?.reason && { reason: mine.reason }),
    ...(mine?.picked && { picked: mine.picked }),
    hostName,
    retry: () => setAttempt((count) => count + 1),
  };
}

function sharedPlayableOf(shared: SharedStream): { source: Source; attempt: Attempt } {
  const { stream, source } = sharedPlayable(shared);
  return { source, attempt: { source: "", stream } };
}

// The guest's candidates in ranking order, the top pick first: unfiltered, so
// their own filter chips never change the party's pick.
function flatten(ranked: { top: Candidate | null; groups: { items: Candidate[] }[] }): Candidate[] {
  const all = ranked.groups.flatMap((group) => group.items);
  return ranked.top ? [ranked.top, ...all.filter((candidate) => candidate !== ranked.top)] : all;
}
