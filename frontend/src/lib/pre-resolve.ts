import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Candidate } from "@/lib/ranking";
import { isPluginSource } from "@/lib/plugins";
import { resolvePick, type Resolved, type ResolveOptions } from "@/lib/resolve";

// Resolving the picker's top pick before it's picked (#101, ADR-0060), when
// the user turned on "Start cached streams sooner" (DeviceSettings
// .preResolve, off by default). The resolve is two thirds of a cached debrid
// stream's time to first frame, almost all of it the addon's and the debrid
// service's own servers, so doing it while the user reads the list is the
// only way to the 3 s target. The cost: resolving a Torrentio stream adds
// its torrent to the user's debrid list, cached or not, played or not. So
// only a cached debrid link resolves ahead, never a torrent, a plugin's
// stream or an uncached one (that starts a download), only the pick itself
// (none of its copies), one at a time, and once per pick per visit.
// usePreparedNext (#65) does the same for the next episode, which the user
// has already chosen to watch.

// How long the top pick stays the same, once every source has answered,
// before it resolves: as usePreparedNext waits.
export const settleAfter = 500;

// How long a link resolved ahead is used for, from when it resolved. CDN
// links last hours, but not forever: past this the pick resolves afresh.
// The player re-resolves a link that has expired anyway (#60).
export const staleAfter = 5 * 60_000;

// Whether a top pick may resolve ahead: a cached debrid stream with a link,
// from an addon.
export function preResolvable(candidate: Candidate): boolean {
  return (
    candidate.parsed.cached === true &&
    candidate.parsed.debrid !== null &&
    !!candidate.stream.url &&
    !isPluginSource(candidate.source)
  );
}

const keyOf = (candidate: Candidate) => `${candidate.source}\n${candidate.stream.url ?? ""}`;

type Ahead = {
  key: string;
  promise: Promise<Resolved>;
  controller: AbortController;
  // When it resolved; undefined while it's out.
  resolvedAt?: number;
  // A pick is waiting on it: a new top pick doesn't abort it.
  taken: boolean;
};

export type PreResolveOptions = {
  // The setting, and not a kids profile.
  enabled: boolean;
  // Every source has answered and what ranks the streams has loaded, so
  // the top pick is the ranking's last word.
  answered: boolean;
  refresh: ResolveOptions["refresh"];
  // Tests pass their own.
  resolve?: ResolveOptions["resolve"];
  now?: () => number;
};

export type PreResolved = {
  // The pick's resolve, when it resolved (or is resolving) ahead and
  // hasn't gone stale; undefined to resolve it now. Any other pick drops
  // what resolved ahead.
  take: (candidate: Candidate) => Promise<Resolved> | undefined;
};

// Resolves `top` ahead while mounted, once the ranking settles on it. A new
// top pick, or none, aborts the last one's resolve and drops its link;
// leaving aborts what's still out.
export function usePreResolve(
  top: Candidate | null,
  { enabled, answered, refresh, resolve, now = Date.now }: PreResolveOptions,
): PreResolved {
  const ahead = useRef<Ahead | null>(null);
  // Picks resolved ahead in this visit: never twice.
  const tried = useRef(new Set<string>());
  const latest = useRef({ top, refresh, resolve, now });
  useLayoutEffect(() => {
    latest.current = { top, refresh, resolve, now };
  });

  const key = top && enabled && answered && preResolvable(top) ? keyOf(top) : undefined;
  useEffect(() => {
    const current = ahead.current;
    if (current && current.key !== key && !current.taken) {
      current.controller.abort();
      ahead.current = null;
    }
    if (!key || tried.current.has(key)) return undefined;
    const timer = setTimeout(() => {
      const { top: candidate, refresh: again, resolve: resolver, now: clock } = latest.current;
      if (!candidate || keyOf(candidate) !== key) return;
      tried.current.add(key);
      const controller = new AbortController();
      // The pick alone: each copy resolved is another entry in a debrid
      // list. If it fails, the pick tries the copies when it's picked.
      const promise = resolvePick(
        { ...candidate, alternates: [] },
        {
          refresh: again,
          openTorrent: () => Promise.reject(new Error("not ahead")),
          signal: controller.signal,
          ...(resolver && { resolve: resolver }),
        },
      );
      const entry: Ahead = { key, promise, controller, taken: false };
      ahead.current = entry;
      promise.then(
        () => {
          entry.resolvedAt = clock();
        },
        () => {
          // A pick waiting on it resolves afresh; nothing else to do.
          if (ahead.current === entry && !entry.taken) ahead.current = null;
        },
      );
    }, settleAfter);
    return () => clearTimeout(timer);
  }, [key]);

  useEffect(
    () => () => {
      ahead.current?.controller.abort();
      ahead.current = null;
    },
    [],
  );

  return {
    take: (candidate) => {
      const current = ahead.current;
      if (!current) return undefined;
      const stale =
        current.resolvedAt !== undefined && latest.current.now() - current.resolvedAt > staleAfter;
      if (current.key !== keyOf(candidate) || stale) {
        if (!current.taken) current.controller.abort();
        ahead.current = null;
        return undefined;
      }
      current.taken = true;
      return current.promise;
    },
  };
}

// `value` as it was when `key` last held still for `delay` ms: while the key
// keeps changing (the picker's filters, chip after chip), the value from
// before; once it settles, the live value again. The picker feeds the
// filtered top pick through this, so toggling filters resolves nothing ahead
// on the way.
export function useSettled<T>(value: T, key: string, delay: number): T {
  const [held, setHeld] = useState({ key, value });
  const fresh = held.key === key;
  // Kept up with while the key holds (state from the last render, as React
  // allows during render).
  if (fresh && held.value !== value) setHeld({ key, value });
  useEffect(() => {
    if (fresh) return undefined;
    const timer = setTimeout(() => setHeld({ key, value }), delay);
    return () => clearTimeout(timer);
  }, [fresh, key, value, delay]);
  return fresh ? value : held.value;
}
