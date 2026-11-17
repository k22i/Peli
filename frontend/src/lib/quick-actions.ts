import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

import type { LibraryItem, Progress } from "@bindings/store";
import { Service as QuickActions } from "@bindings/quickactions";
import type { Action, Item } from "@bindings/quickactions";
import { addonsFor, metaQuery, type LoadedAddon } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { continueWatchingQuery, episodeLabel, libraryQuery, timeLeft } from "@/lib/library";
import { usePlay } from "@/lib/playback";
import { isIOS } from "@/lib/platform";
import { titleParams, titlePath } from "@/lib/title";

// The Home Screen icon menu (#141): Search and Library are static items in
// Info.plist; Continue watching is sent from here, because only the frontend
// knows every title's name (the library's copy, or the addons' meta in the
// persisted cache). A tap comes back as an action waiting in Go
// (internal/quickactions), which the shell takes once a profile is in use.

// How many entries are looked at to fill the menu's two places: some may
// have no name yet (no library copy, no addon with its meta).
const candidates = 4;
// The menu waits this long after Continue Watching changes (a film saving its
// progress touches it every few seconds).
const debounceMs = 1000;

// The menu's lines for the entries, newest first: "S1 · E2 · 34 min left".
// An entry whose name isn't known is left out (the content id would only show
// as "tt1234567"). A PIN-locked profile gets none: the menu is on the Home
// Screen, and its titles would show what was watched.
export function quickItems(
  entries: readonly Progress[],
  names: (entry: Progress) => string | undefined,
  locked: boolean,
): Item[] {
  if (locked) return [];
  const items: Item[] = [];
  for (const entry of entries.slice(0, candidates)) {
    const title = names(entry);
    if (!title) continue;
    items.push({
      type: entry.contentType,
      id: entry.contentId,
      videoId: entry.videoId,
      title,
      subtitle: [episodeLabel(entry), timeLeft(entry)].filter(Boolean).join(" · "),
    });
  }
  return items;
}

type Details = { library: readonly LibraryItem[]; addons: readonly LoadedAddon[] };

// Keeps the icon menu's Continue watching items up to date for a profile in
// use. Mounted on iOS only.
export function useQuickActionSync(profileId: number, locked: boolean) {
  const watching = useQuery(continueWatchingQuery(profileId)).data;
  const library = useQuery(libraryQuery(profileId)).data;
  const { addons } = useLoadedAddons(profileId);
  const entries = (watching ?? []).slice(0, candidates);
  const details: Details = { library: library ?? [], addons };
  const metas = useQueries({
    queries: entries.map((entry) => {
      const saved = details.library.some((item) => item.contentId === entry.contentId);
      const [addon] = addonsFor(addons, "meta", entry.contentType, entry.contentId);
      return {
        ...metaQuery(addon?.url ?? "", entry.contentType, entry.contentId),
        enabled: !saved && addon !== undefined,
      };
    }),
  });
  const items = quickItems(
    entries,
    (entry) =>
      details.library.find((item) => item.contentId === entry.contentId)?.name ||
      metas[entries.indexOf(entry)]?.data?.meta.name,
    locked,
  );
  const serialized = JSON.stringify(items);

  const push = useEffectEvent(() => {
    QuickActions.SetItems(items).catch(() => {});
  });

  // Debounced, but a lock is never waited on: the previous profile's titles
  // must not stay on the Home Screen while a PIN-locked one is in use.
  useEffect(() => {
    const now = locked || serialized === "[]";
    const timer = setTimeout(push, now ? 0 : debounceMs);
    return () => clearTimeout(timer);
  }, [serialized, locked]);

  // Leaving the app (a call, the switcher, a swipe home): send what is
  // current now, before the page is suspended.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") push();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
}

// Carries out icon-menu taps, one at a time, once `ready`: a profile is in
// use (no picker in front) and its PIN, if it has one, was entered. Until
// then the tap waits here (and in Go, for a launch that came from it).
export function useQuickActionHandler(ready: boolean) {
  const navigate = useNavigate();
  const play = usePlay();
  const waiting = useRef<Action | null>(null);

  const run = useEffectEvent((action: Action) => {
    switch (action.kind) {
      case "search":
        void navigate({ to: "/search" });
        return;
      case "library":
        void navigate({ to: "/library" });
        return;
      case "title": {
        if (!action.type || !action.id) return;
        const target = {
          type: action.type,
          id: action.id,
          title: action.title ?? "",
          videoId: action.videoId || undefined,
        };
        if (action.play) play(target);
        else void navigate({ to: titlePath, params: titleParams(target) });
      }
    }
  });

  // A tap runs at once if the app is ready for it, else when it becomes so.
  const arrived = useEffectEvent((action: Action) => {
    if (ready) run(action);
    else waiting.current = action;
  });

  useEffect(() => {
    if (!isIOS()) return undefined;
    const take = () => {
      QuickActions.TakePending()
        .then((action) => action && arrived(action))
        .catch(() => {});
    };
    // A launch from the menu is already waiting in Go.
    take();
    return Events.On("quickactions:pending", take);
  }, []);

  useEffect(() => {
    const action = waiting.current;
    if (!ready || !action) return;
    waiting.current = null;
    run(action);
  }, [ready]);
}

// The sync, as a component, for the profile gate to mount on iOS.
export function QuickActionSync({ profileId, locked }: { profileId: number; locked: boolean }) {
  useQuickActionSync(profileId, locked);
  return null;
}
