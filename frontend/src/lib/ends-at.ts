import { useEffect, useState } from "react";

// "Ends at 10:42 PM": when a film or episode would end if it played from
// now. The title page shows it for what Play plays, the player beside the
// time remaining. The clock follows the system's locale, so its 12- or
// 24-hour form is the locale's (Intl), never a fixed one.

// The wall-clock time (ms since epoch) `remaining` seconds of playback end,
// at `speed`. Nothing to play, or a speed that doesn't move, has no end.
export function endsAt(now: number, remaining: number, speed = 1): number | undefined {
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
  if (!Number.isFinite(speed) || speed <= 0) return undefined;
  return now + (remaining / speed) * 1000;
}

// "10:42 PM" or "22:42", as the locale writes it. `hourCycle` is only for
// tests; the app leaves it to the locale.
export function clockTime(
  time: number,
  locale?: Intl.LocalesArgument,
  hourCycle?: Intl.DateTimeFormatOptions["hourCycle"],
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(hourCycle ? { hourCycle } : {}),
  }).format(time);
}

export const endsAtLabel = (time: number, locale?: Intl.LocalesArgument) =>
  `Ends at ${clockTime(time, locale)}`;

// An addon's runtime as seconds: "49 min", "1h 30min", "2 h", "142", "1:45".
// Anything else is undefined.
export function runtimeSeconds(runtime: string | undefined): number | undefined {
  const text = runtime?.trim().toLowerCase();
  if (!text) return undefined;
  const clock = /^(\d+):(\d{2})$/.exec(text);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 60;
  if (/^\d+$/.test(text)) return Number(text) * 60 || undefined;
  const hours = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/.exec(text);
  const minutes = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/.exec(text);
  if (!hours && !minutes) return undefined;
  const seconds = Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60;
  return seconds > 0 ? Math.round(seconds) : undefined;
}

// What's left of a film or episode, in seconds: from its progress when
// there is some (ms, as Nuvio keeps it), else its whole runtime.
export function remainingSeconds(
  runtime: string | undefined,
  progress?: { position: number; duration: number },
): number | undefined {
  if (progress && progress.duration > 0) {
    return Math.max(0, (progress.duration - progress.position) / 1000);
  }
  const whole = runtimeSeconds(runtime);
  if (whole === undefined) return undefined;
  return Math.max(0, whole - (progress?.position ?? 0) / 1000);
}

// The ms to wait for the clock's next step (a minute by default), so a
// shown time turns over with the system clock.
export const untilNextStep = (now: number, step = 60_000) => step - (now % step);

// The time now, updated at each step of the clock (each minute unless
// asked): what keeps "Ends at" moving while nothing plays (paused, or a
// title page left open).
export function useClock(step = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, untilNextStep(Date.now(), step));
    };
    timer = setTimeout(tick, untilNextStep(Date.now(), step));
    return () => clearTimeout(timer);
  }, [step]);
  return now;
}
