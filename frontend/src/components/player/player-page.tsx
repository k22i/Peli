import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertCircle, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { repaintWindow } from "@/lib/theme";
import { Player, reloadExpired, usePlayerEnded, usePlayerState, type Ended } from "@/lib/player";

// What a failed file says, by internal/player's end codes.
const failures: Record<string, { title: string; description: string }> = {
  expired: {
    title: "The link expired",
    description: "Go back and pick the stream again for a new link.",
  },
  unsupported: {
    title: "Sinag can’t play this file",
    description: "Go back and pick another stream.",
  },
};
const failed = {
  title: "The stream stopped",
  description: "It couldn’t be loaded. Go back and pick another stream.",
};

// The player screen (#60): the video under a transparent page, with no app
// shell. This is the bare minimum to watch and leave: a click or Space
// pauses, Esc or Back stops and goes back. The real controls are #61's.
export function PlayerPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const playing = useLocation({ select: (location) => location.state.player });
  const title = playing?.title;
  const state = usePlayerState();
  const [error, setError] = useState<Ended>();
  // The source now playing, and when its link was last asked for again.
  const source = useRef(playing?.source);
  const reloadedAt = useRef(0);

  const leave = () => (canGoBack ? router.history.back() : void navigate({ to: "/" }));
  // Leaving the screen, however it happens, ends the session.
  useEffect(
    () => () => {
      Player.Stop()
        .catch(() => {})
        .finally(repaintWindow);
    },
    [],
  );
  usePlayerEnded((ended) => {
    if (ended.reason === "eof") return leave();
    // A link that expired mid-play is asked for again, at most once a
    // minute, and plays on from where it stopped.
    const expired = source.current;
    if (ended.code === "expired" && expired && Date.now() - reloadedAt.current > 60_000) {
      reloadedAt.current = Date.now();
      reloadExpired(expired, state.position).then(
        (fresh) => {
          source.current = fresh;
        },
        () => setError(ended),
      );
      return;
    }
    setError(ended);
  });
  const togglePause = () => {
    if (state.active) Player.SetPaused(!state.paused).catch(() => {});
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !state.fullscreen) leave();
      else if (event.key === " ") {
        event.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const failure = error && (failures[error.code ?? ""] ?? failed);
  return (
    <div className="fixed inset-0 text-white select-none">
      {/* The video itself: a click pauses, a double click goes fullscreen. */}
      <button
        type="button"
        aria-label={state.paused ? "Play" : "Pause"}
        className="absolute inset-0 cursor-default outline-none"
        onClick={togglePause}
        onDoubleClick={() => Player.SetFullscreen(!state.fullscreen).catch(() => {})}
      />
      {/* Room for the macOS traffic lights, and a drag strip. */}
      <div className="absolute inset-x-0 top-0 flex h-16 items-center gap-2 bg-linear-to-b from-black/60 to-transparent pl-20 pr-4 drag-region">
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Back"
          onClick={leave}
          className="rounded-full text-white hover:bg-white/15 hover:text-white"
        >
          <ChevronLeft className="size-5" />
        </Button>
        {title && <h1 className="truncate text-sm font-medium">{title}</h1>}
      </div>
      {failure ? (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-black/70">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <AlertCircle className="size-8 text-white/70" />
            <p className="text-lg font-semibold">{failure.title}</p>
            <p className="text-sm text-white/70">{failure.description}</p>
            <Button variant="secondary" onClick={leave} className="mt-2">
              Back
            </Button>
          </div>
        </div>
      ) : (
        (state.loading || state.buffering) && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-10 text-white/80" />
          </div>
        )
      )}
    </div>
  );
}
