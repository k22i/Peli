import { useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  blocksFor,
  clockLabel,
  guideQuery,
  guideRange,
  isOnNow,
  offsetOf,
  slotsOf,
  usePlayChannel,
  type Channel,
  type GuideBlock,
  type Programme,
} from "@/lib/livetv";
import { useCurrentProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";

import { GuideDetails } from "./guide-details";

// A half hour is 180 px: a programme's length reads at a glance, and an hour
// fits a title and its times.
const pxPerMinute = 6;
const rowHeight = 64;
const headerHeight = 40;
// 13 rem, as the corner cell and the channel column are.
const channelColumn = 208;
// A long playlist's guide is asked for a chunk of rows at a time: 500
// channels' programmes at once is far too much to parse and hold.
const chunkRows = 40;
// How far back the first scroll puts the current time, so what's on now is
// readable from the left edge.
const leadInMs = 15 * 60_000;

// The guide view of /live (W6): every channel in the chip that's on, one row
// each, against a time axis. The grid is its own scroll container in both
// directions, which keeps the time header at its top and the channel column at
// its left; the rows are virtualized, so a long playlist opens at once.
export function GuideGrid({
  channels,
  group,
}: {
  // The channels of the chip that's on, in order: one row each.
  channels: readonly Channel[];
  // The chip's group value, handed to playChannel for channel up and down.
  group: string;
}) {
  const profileId = useCurrentProfile().id ?? 0;
  const play = usePlayChannel();
  const scrollRef = useRef<HTMLElement>(null);
  // The span is fixed while the view is open, and so is when it opened: the
  // first scroll puts that time near the left edge.
  const [openedAt] = useState(Date.now);
  const [range] = useState(() => guideRange(openedAt));
  const [now, setNow] = useState(openedAt);
  // The programme a click opened the details for; none while it's closed.
  const [details, setDetails] = useState<{ programme: Programme; channel: Channel }>();
  const width = offsetOf(range.to, range.from, pxPerMinute);

  // The blocks and the now line move on while the view is open, though the
  // axis does not.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 0, height: window.innerHeight },
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, offsetOf(openedAt - leadInMs, range.from, pxPerMinute));
  }, [openedAt, range.from]);

  const ids = useMemo(() => channels.map((channel) => channel.id), [channels]);
  // Only the chunks of row the virtualizer has mounted are asked for, so
  // scrolling down a long playlist fetches the next chunk, not the whole
  // guide.
  const chunks = [
    ...new Set(virtualizer.getVirtualItems().map((item) => Math.floor(item.index / chunkRows))),
  ];
  const results = useQueries({
    queries: chunks.map((chunk) =>
      guideQuery(
        profileId,
        ids.slice(chunk * chunkRows, chunk * chunkRows + chunkRows),
        range.from,
        range.to,
      ),
    ),
  });

  // Each channel's programmes, and which chunks have answered: a channel with
  // an empty guide only says so once its chunk has loaded, never while it's
  // still on its way.
  const programmesByChannel = new Map<string, Programme[]>();
  const answeredChunks = new Set<number>();
  results.forEach((result, index) => {
    const chunk = chunks[index];
    if (chunk === undefined || result.data === undefined) return;
    answeredChunks.add(chunk);
    // Go's list fields reach the frontend as nullable.
    for (const guide of result.data) {
      programmesByChannel.set(guide.channelId, guide.programmes ?? []);
    }
  });

  // The page shows its own notice with nothing to guide.
  if (channels.length === 0) return null;

  return (
    <section
      aria-label="Programme guide"
      ref={scrollRef}
      className="relative mx-page overflow-auto rounded-2xl bg-foreground/3"
      style={{ height: "calc(100dvh - 15rem)" }}
    >
      <div
        className="relative"
        style={{ width: channelColumn + width, height: headerHeight + virtualizer.getTotalSize() }}
      >
        <div className="sticky top-0 z-20 flex h-10 bg-background/95">
          <div className="sticky left-0 z-30 w-52 shrink-0 bg-background/95 px-3 text-small font-medium leading-10">
            Channels
          </div>
          <div className="relative" style={{ width }}>
            {slotsOf(range.from, range.to).map((time) => (
              <span
                key={time}
                className="absolute border-s border-foreground/10 ps-2 text-small leading-10 text-muted-foreground tnum"
                style={{ left: offsetOf(time, range.from, pxPerMinute) }}
              >
                {clockLabel(time)}
              </span>
            ))}
          </div>
        </div>

        {now >= range.from && now < range.to && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-sun"
            style={{ left: channelColumn + offsetOf(now, range.from, pxPerMinute) }}
          />
        )}

        {virtualizer.getVirtualItems().map((item) => {
          const channel = channels[item.index];
          if (!channel) return null;
          const programmes = programmesByChannel.get(channel.id) ?? [];
          const answered = answeredChunks.has(Math.floor(item.index / chunkRows));
          return (
            <div
              key={channel.id}
              className="absolute left-0 flex"
              style={{
                top: headerHeight + item.start,
                height: rowHeight,
                width: channelColumn + width,
              }}
            >
              <div className="sticky left-0 z-10 flex w-52 shrink-0 items-center gap-2 border-b border-foreground/5 bg-background px-3">
                <ChannelLogo channel={channel} />
                <span className="truncate text-small font-medium">{channel.name}</span>
                <span className="text-small text-muted-foreground tnum">{channel.number}</span>
              </div>
              <div className="relative border-b border-foreground/5" style={{ width }}>
                {answered && programmes.length === 0 ? (
                  <div className="absolute inset-0 flex items-center px-2 text-small text-muted-foreground">
                    No guide
                  </div>
                ) : (
                  blocksFor(programmes, range.from, range.to, pxPerMinute).map((block) => (
                    <ProgrammeBlock
                      key={`${block.programme.channelId}:${block.programme.start}`}
                      block={block}
                      now={now}
                      onPlay={() => void play(channel, group)}
                      onOpen={(programme) => setDetails({ programme, channel })}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <GuideDetails
        programme={details?.programme}
        channel={details?.channel}
        onClose={() => setDetails(undefined)}
      />
    </section>
  );
}

// A channel's logo, or its first two letters when it has none or the image
// won't load.
function ChannelLogo({ channel }: { channel: Channel }) {
  const [broken, setBroken] = useState(false);
  if (!channel.logo || broken) {
    return (
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-md bg-foreground/8 text-small font-medium uppercase"
      >
        {channel.name.slice(0, 2)}
      </span>
    );
  }
  return (
    <img
      alt=""
      src={channel.logo}
      loading="lazy"
      className="size-9 rounded-md object-contain"
      onError={() => setBroken(true)}
    />
  );
}

// One programme on a channel's row: a click plays the channel when it's on,
// and opens its details otherwise.
function ProgrammeBlock({
  block,
  now,
  onPlay,
  onOpen,
}: {
  block: GuideBlock;
  now: number;
  onPlay: () => void;
  onOpen: (programme: Programme) => void;
}) {
  const { programme, left, width } = block;
  const on = isOnNow(programme, now);
  const start = clockLabel(programme.start);
  const stop = clockLabel(programme.stop);
  return (
    <button
      type="button"
      aria-label={`${programme.title}, ${start} to ${stop}${on ? ", on now" : ""}`}
      onClick={() => (on ? onPlay() : onOpen(programme))}
      className={cn(
        "absolute top-1.5 bottom-1.5 overflow-hidden rounded-lg px-2 text-start text-small",
        on ? "bg-foreground/15 ring-1 ring-sun/40" : "bg-foreground/8 hover:bg-foreground/12",
        programme.stop <= now && "opacity-60",
      )}
      style={{ left, width: Math.max(width - 4, 0) }}
    >
      <span className="block truncate font-medium">{programme.title}</span>
      {width > 90 && (
        <span className="block truncate text-muted-foreground tnum">
          {start}–{stop}
        </span>
      )}
    </button>
  );
}
