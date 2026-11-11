import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// "Still watching?" over the end of an episode: the next one waits for an
// answer. It takes focus, so Enter plays on; Esc leaves (the page's keys).
export function StillWatching({
  title,
  episodes,
  mini,
  onContinue,
  onStop,
}: {
  // The show's name.
  title: string;
  // How many played in a row.
  episodes: number;
  mini: boolean;
  onContinue: () => void;
  onStop: () => void;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus({ preventScroll: true }), []);
  return (
    <div
      role="alertdialog"
      aria-labelledby="still-watching-title"
      aria-describedby="still-watching-description"
      className="absolute inset-0 z-20 grid place-items-center bg-black/80 p-4 reduced-transparency:bg-black motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500"
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col items-center text-center",
          mini ? "gap-2" : "gap-4",
        )}
      >
        <p
          id="still-watching-title"
          className={cn("font-display leading-none", mini ? "text-xl" : "text-[2.25rem]")}
        >
          Still watching{title ? ` ${title}` : ""}?
        </p>
        <p
          id="still-watching-description"
          className={cn("text-body text-white/70", mini && "sr-only")}
        >
          {episodes} episodes have played without a break. The next one waits for you.
        </p>
        <div className={cn("flex gap-2.5", mini ? "mt-1" : "mt-3")}>
          <Button ref={primary} variant="light" size={mini ? "sm" : "lg"} onClick={onContinue}>
            Play the next episode
          </Button>
          <Button variant="media" size={mini ? "sm" : "lg"} onClick={onStop}>
            Stop
          </Button>
        </div>
      </div>
    </div>
  );
}
