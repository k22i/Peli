import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Service as Player, type Ended, type State } from "@bindings/player";
import { Service as Streams, type Source } from "@bindings/streams";

// The player (#60, ADR-0039): libmpv in Go, under the webview, driven
// through internal/player's Service. Its state comes back as events:
// player:state (everything but the time, when it changes), player:time
// (position, duration and buffer, ~4 a second) and player:ended (played to
// the end, or failed). Events sent before a page listens arrive late, so
// usePlayerState reads a snapshot when it mounts. Times are in seconds.

export const stateEvent = "player:state";
export const timeEvent = "player:time";
export const endedEvent = "player:ended";

export { Player };
export type { Ended };
export type PlayerState = State;

export const idleState: PlayerState = {
  active: false,
  loading: false,
  paused: false,
  buffering: false,
  bufferPercent: 0,
  seeking: false,
  position: 0,
  duration: 0,
  buffered: 0,
  volume: 100,
  muted: false,
  speed: 1,
  fullscreen: false,
  tracks: [],
  hwdec: "",
};

// The player's state: a snapshot on mount, then every event after it.
export function usePlayerState(): PlayerState {
  const [state, setState] = useState<PlayerState>(idleState);
  useEffect(() => {
    let live = true;
    // An event that lands before the snapshot is newer than it.
    let heard = false;
    const offState = Events.On(stateEvent, (event) => {
      heard = true;
      setState(event.data);
    });
    const offTime = Events.On(timeEvent, (event) => {
      setState((current) => ({ ...current, ...event.data }));
    });
    Player.Snapshot()
      .then((snapshot) => {
        if (live && !heard) setState(snapshot);
      })
      .catch(() => {});
    return () => {
      live = false;
      offState();
      offTime();
    };
  }, []);
  return state;
}

// Calls onEnded when a file ends by itself.
export function usePlayerEnded(onEnded: (ended: Ended) => void) {
  const ended = useEffectEvent(onEnded);
  useEffect(() => Events.On(endedEvent, (event) => ended(event.data)), []);
}

// Asks for an expired link again from its addon, through the redirects
// (ADR-0037), and plays the new one from position. Debrid links expire,
// sometimes mid-film. Returns the new source.
export async function reloadExpired(source: Source, position: number): Promise<Source> {
  const fresh = await Streams.Resolve({ url: source.origin, headers: source.headers });
  await Player.Load(fresh, { start: position });
  return fresh;
}

// "4:05", or "1:02:03" from an hour on.
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Sends one value at a time, and when it's done the newest that came in
// meanwhile: a drag makes dozens of values a second, and the player only
// has to follow the last. Errors are dropped, as the state events say what
// happened.
export function latestOnly<T>(send: (value: T) => Promise<unknown>): (value: T) => void {
  let busy = false;
  let next: { value: T } | undefined;
  const run = (value: T) => {
    busy = true;
    send(value)
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (!next) return;
        const queued = next.value;
        next = undefined;
        run(queued);
      });
  };
  return (value) => {
    if (busy) next = { value };
    else run(value);
  };
}

// A value the user just set, shown in place of the player's until the
// player's catches up (reached says when) or a few seconds pass. A round
// trip through mpv takes 100 ms and more on a slow machine, and controls
// that wait for it feel broken (M0, #8).
export function useAhead<T>(
  actual: T,
  reached: (actual: T, wanted: T) => boolean,
): [shown: T, set: (wanted: T) => void] {
  const [wanted, setWanted] = useState<{ value: T }>();
  if (wanted && reached(actual, wanted.value)) setWanted(undefined);
  useEffect(() => {
    if (!wanted) return undefined;
    const timer = setTimeout(() => setWanted(undefined), aheadFor);
    return () => clearTimeout(timer);
  }, [wanted]);
  return [wanted ? wanted.value : actual, (value) => setWanted({ value })];
}

const aheadFor = 3000;

// Whether the pointer and keys have been still for ms, and wake, to call
// on every move or key.
export function useIdle(ms: number): [idle: boolean, wake: () => void] {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), ms);
    setIdle(false);
  };
  useEffect(() => {
    timer.current = setTimeout(() => setIdle(true), ms);
    return () => clearTimeout(timer.current);
  }, [ms]);
  return [idle, wake];
}
