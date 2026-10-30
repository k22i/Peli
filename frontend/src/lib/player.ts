import { Events } from "@wailsio/runtime";
import { useEffect, useEffectEvent, useState } from "react";

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
