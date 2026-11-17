import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Connection, Service as Sync } from "@bindings/syncer";
import { toastManager } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { haptic } from "@/lib/haptics";
import { isIOS } from "@/lib/platform";
import {
  endPull,
  idlePull,
  movePull,
  pullProgress,
  refreshTimeoutMs,
  spinnerPt,
  startPull,
  type Pull,
} from "@/lib/pull-refresh";
import { connectionQuery } from "@/lib/sync";
import { cn } from "@/lib/utils";

// Pull to refresh on iOS (#135). A page that refreshes says how with
// usePullToRefresh; the shell's PullToRefresh watches the content pane's
// touches and shows the spinner. One page at a time: the last one mounted.

type Refresh = () => Promise<unknown>;

let current: Refresh | undefined;
const listeners = new Set<() => void>();

// Makes the page that calls it refreshable by pulling the content pane down
// (iOS only; nothing elsewhere). `refresh` runs on release past the
// threshold; the spinner stays until it settles, 10 s at most.
export function usePullToRefresh(refresh: Refresh) {
  const run = useEffectEvent(refresh);
  useEffect(() => {
    if (!isIOS()) return undefined;
    const mine: Refresh = () => run();
    current = mine;
    for (const listener of listeners) listener();
    return () => {
      if (current === mine) current = undefined;
      for (const listener of listeners) listener();
    };
  }, []);
}

function useRefreshable(): boolean {
  const [refreshable, setRefreshable] = useState(current !== undefined);
  useEffect(() => {
    const update = () => setRefreshable(current !== undefined);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return refreshable;
}

// Home and the Library: push what's queued and pull from Nuvio now, past the
// pull's throttle (Syncer.Refresh), and refetch the tracker lists. The
// pull's sync:pulled event refreshes the surfaces it changed.
export async function refreshSynced(client: QueryClient) {
  await Promise.allSettled([
    Sync.Refresh(),
    client.invalidateQueries({ queryKey: ["tracking"], refetchType: "active" }),
  ]);
}

function offline(client: QueryClient): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  return client.getQueryData(connectionQuery.queryKey) === Connection.Offline;
}

// The spinner under the header, and the touch handling on `pane`. Mounted
// by the shell on iOS only.
export function PullToRefresh({ pane }: { pane: HTMLElement | null }) {
  const client = useQueryClient();
  const refreshable = useRefreshable();
  const [pull, setPull] = useState<Pull>(idlePull);
  const [refreshing, setRefreshing] = useState(false);
  const state = useRef<Pull>(idlePull);
  const busy = useRef(false);

  const refresh = useEffectEvent(() => {
    const run = current;
    if (!run || busy.current) return;
    if (offline(client)) {
      toastManager.add({ type: "info", title: "You're offline. Showing what's on this device." });
      return;
    }
    busy.current = true;
    setRefreshing(true);
    const timeout = new Promise((resolve) => setTimeout(resolve, refreshTimeoutMs));
    void Promise.race([run().catch(() => {}), timeout]).finally(() => {
      busy.current = false;
      setRefreshing(false);
    });
  });

  useEffect(() => {
    if (!pane || !refreshable) return undefined;
    const set = (next: Pull) => {
      state.current = next;
      setPull(next);
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) {
        set(idlePull);
        return;
      }
      set(startPull(touch.clientX, touch.clientY, pane.scrollTop <= 0, !busy.current));
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || state.current.phase === "idle") return;
      const { state: next, crossed } = movePull(state.current, touch.clientX, touch.clientY);
      if (crossed) haptic("medium");
      set(next);
    };
    const onEnd = () => {
      const action = endPull(state.current);
      set(idlePull);
      if (action === "refresh") refresh();
    };
    pane.addEventListener("touchstart", onStart, { passive: true });
    pane.addEventListener("touchmove", onMove, { passive: true });
    pane.addEventListener("touchend", onEnd, { passive: true });
    pane.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      pane.removeEventListener("touchstart", onStart);
      pane.removeEventListener("touchmove", onMove);
      pane.removeEventListener("touchend", onEnd);
      pane.removeEventListener("touchcancel", onEnd);
      state.current = idlePull;
    };
  }, [pane, refreshable]);

  const progress = refreshing ? 1 : pullProgress(pull);
  const pulling = pull.phase === "pulling";
  if (!refreshable && !refreshing) return null;
  return (
    <div
      aria-hidden={!refreshing}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-[calc(var(--spacing-bar)+0.5rem)] z-10 flex justify-center",
        // Follows the finger while pulling; settles back when let go.
        !pulling && "transition-[opacity,translate] duration-(--duration-base) ease-out-soft",
      )}
      style={{
        opacity: progress,
        translate: `0 ${(progress - 1) * 24}px`,
      }}
    >
      <div
        className="material-pop flex items-center justify-center rounded-full"
        style={{ width: spinnerPt, height: spinnerPt }}
      >
        <Spinner
          aria-label={refreshing ? "Refreshing" : "Pull to refresh"}
          className={cn("size-4.5 text-foreground/80", !refreshing && "animate-none")}
          style={refreshing ? undefined : { rotate: `${progress * 270}deg` }}
        />
      </div>
    </div>
  );
}
