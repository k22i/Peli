// The sleep timer (More › Sleep timer): at the end of the episode, or after
// 15, 30 or 60 minutes, the volume fades over the last 10 seconds, then
// playback pauses and the volume comes back for the next play. It lives on
// the player screen, so minutes run on into the next episode; the end of
// an episode is that file's.

export type SleepTimer =
  | { kind: "off" }
  | { kind: "episode"; file: string }
  | { kind: "minutes"; minutes: number; ends: number };

export const sleepOff: SleepTimer = { kind: "off" };

// The menu's choices, by value.
export const sleepChoices = [
  { value: "off", name: "Off" },
  { value: "episode", name: "End of episode" },
  { value: "15", name: "15 minutes" },
  { value: "30", name: "30 minutes" },
  { value: "60", name: "60 minutes" },
] as const;

export type SleepChoice = (typeof sleepChoices)[number]["value"];

// How long the volume takes to fade out, in seconds.
export const fadeFor = 10;

// The episode timer pauses this close to the end: time events come four a
// second, and at the end itself the next episode would start.
export const episodeMargin = 0.6;

// The timer a choice sets, from now, for the file playing.
export function sleepTimerFor(choice: SleepChoice, file: string, now: number): SleepTimer {
  if (choice === "off") return sleepOff;
  if (choice === "episode") return { kind: "episode", file };
  const minutes = Number(choice);
  return { kind: "minutes", minutes, ends: now + minutes * 60_000 };
}

export function sleepChoiceOf(timer: SleepTimer): SleepChoice {
  if (timer.kind === "off") return "off";
  if (timer.kind === "episode") return "episode";
  const minutes = String(timer.minutes);
  return sleepChoices.find((each) => each.value === minutes)?.value ?? "off";
}

// Seconds of playback left before the timer pauses it; undefined when it's
// off, or the episode's length isn't known. Speed shortens an episode.
export function sleepLeft(
  timer: SleepTimer,
  now: number,
  playing: { position: number; duration: number; speed: number },
): number | undefined {
  if (timer.kind === "minutes") return Math.max(0, (timer.ends - now) / 1000);
  if (timer.kind === "episode" && playing.duration > 0) {
    const left = (playing.duration - playing.position - episodeMargin) / (playing.speed || 1);
    return Math.max(0, left);
  }
  return undefined;
}

// The volume while it fades: all of it until the last fadeFor seconds, then
// down to nothing, on a curve that sounds even.
export function fadedVolume(volume: number, left: number): number {
  const share = Math.min(1, Math.max(0, left / fadeFor));
  return Math.round(volume * share * share);
}

// The menu's hint: "12 min", "1 min", "End of episode".
export function sleepHint(timer: SleepTimer, left: number | undefined): string | undefined {
  if (timer.kind === "off") return undefined;
  if (timer.kind === "episode") return "End of episode";
  return `${Math.max(1, Math.ceil((left ?? 0) / 60))} min`;
}
