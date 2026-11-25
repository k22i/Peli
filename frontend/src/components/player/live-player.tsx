import type { LivePlay } from "@/lib/livetv";

// The player screen for a live channel (W7: TODO).
export function LivePlayer({ live }: { live: LivePlay }) {
  return live.channelId ? null : null;
}
