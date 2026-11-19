import { endsAt, endsAtLabel, useClock } from "@/lib/ends-at";
import { cn } from "@/lib/utils";

// "Ends at 10:42 PM" beside the time remaining: when playback would end at
// this speed. It follows the position as it plays or seeks, and the clock
// while paused, so the time moves on as the pause lasts.
export function PlayerEndsAt({
  remaining,
  speed,
  className,
}: {
  // Seconds of the file left.
  remaining: number;
  speed: number;
  className?: string;
}) {
  // The clock by the second, so the minute shown turns over on time.
  const now = useClock(1000);
  const end = endsAt(now, remaining, speed);
  if (end === undefined) return null;
  return (
    <p
      data-testid="ends-at"
      className={cn("shrink-0 whitespace-nowrap text-white/70 tnum", className)}
    >
      {endsAtLabel(end)}
    </p>
  );
}
