import type { Channel } from "@/lib/livetv";

// The guide view of /live (W6: TODO).
export function GuideGrid({
  channels,
  group,
}: {
  // The channels of the chip that's on, in order: one row each.
  channels: readonly Channel[];
  // The chip's group value, handed to playChannel for channel up and down.
  group: string;
}) {
  return channels.length > 0 && group ? null : null;
}
