import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { scrollParent } from "@/components/media/poster-grid";
import { Button } from "@/components/ui/button";
import {
  clockLabel,
  nowNextFor,
  nowNextQuery,
  progressOf,
  usePlayChannel,
  useToggleFavourite,
  type Channel,
  type NowNext,
} from "@/lib/livetv";

// How often the rows' clock moves: a progress bar that never moved would say
// the schedule had stopped.
const tickMs = 30_000;

// The channels of the group that's on, one row each, in the page's order.
// The list is virtualized (a large playlist is thousands of rows, #41's
// reason), so only the rows near the viewport are mounted.
export function ChannelList({
  channels,
  group,
  profileId,
  favourites,
}: {
  // The channels to list, already grouped and filtered by the page.
  channels: readonly Channel[];
  // The group that's on: what channel up and down step through in the
  // player.
  group: string;
  profileId: number;
  // The profile's favourite channel ids.
  favourites: readonly string[];
}) {
  const list = useRef<HTMLUListElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);
  const play = usePlayChannel();
  const toggle = useToggleFavourite(profileId);
  const ids = useMemo(() => channels.map((channel) => channel.id), [channels]);
  const nowNext = useQuery(nowNextQuery(profileId, ids)).data;
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const scroller = scrollParent(element);
    setScrollElement(scroller);
    // The list's place in the page, which the virtualizer measures its rows
    // from: the header above it moves as the page scrolls.
    const update = () =>
      setTop(
        element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 76,
    scrollMargin: top,
    overscan: 6,
    initialRect: { width: 0, height: window.innerHeight },
  });

  return (
    <ul
      ref={list}
      aria-label="Channels"
      className="relative px-page"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const channel = channels[row.index]!;
        return (
          <li
            key={channel.id}
            className="absolute inset-x-0"
            style={{ top: row.start - virtualizer.options.scrollMargin }}
          >
            <ChannelRow
              channel={channel}
              entry={nowNextFor(nowNext, channel.id)}
              favourite={favourites.includes(channel.id)}
              clock={clock}
              group={group}
              play={play}
              onFavourite={(channelId, on) => toggle.mutate({ channelId, on })}
            />
          </li>
        );
      })}
    </ul>
  );
}

// A channel: its number and logo, its name, what it shows now (with how far
// through) and next, and the star that keeps it in the favourites. The row's
// main part is the button that plays it.
function ChannelRow({
  channel,
  entry,
  favourite,
  clock,
  group,
  play,
  onFavourite,
}: {
  channel: Channel;
  // What the guide says it shows now and next, when it says anything.
  entry: NowNext | undefined;
  favourite: boolean;
  clock: number;
  group: string;
  play: (channel: Channel, group: string) => Promise<boolean>;
  onFavourite: (channelId: string, on: boolean) => void;
}) {
  const now = entry?.now ?? undefined;
  const next = entry?.next ?? undefined;
  const progress = now ? progressOf(now, clock) : 0;
  return (
    <div className="flex h-[76px] items-center gap-3 rounded-xl px-3 hover:bg-foreground/5">
      <button
        type="button"
        // The name, not "1 News One Midnight News …": a channel is played by
        // its name.
        aria-label={channel.name}
        onClick={() => void play(channel, group)}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span className="w-8 shrink-0 text-end text-small text-muted-foreground tnum">
          {channel.number}
        </span>
        <ChannelLogo channel={channel} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{channel.name}</span>
          {now && (
            // The title and how far through it is share a line: three lines
            // in all fit the row's 76 pt.
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate text-small text-muted-foreground">{now.title}</span>
              <progress
                max={1}
                value={progress}
                aria-label={`${now.title}, ${Math.round(progress * 100)}% watched`}
                className="h-[3px] w-20 shrink-0 appearance-none overflow-hidden rounded-full bg-foreground/10 [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-foreground/70"
              />
            </span>
          )}
          {next && (
            <span className="block truncate text-small text-muted-foreground">
              Next · {clockLabel(next.start)} {next.title}
            </span>
          )}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={favourite}
        aria-label={
          favourite ? `Remove ${channel.name} from favourites` : `Add ${channel.name} to favourites`
        }
        onClick={() => onFavourite(channel.id, !favourite)}
      >
        <Star aria-hidden fill={favourite ? "currentColor" : "none"} />
      </Button>
    </div>
  );
}

// The channel's logo, or its first two letters when it has none or the image
// fails: a broken image would leave a hole where the channel is.
function ChannelLogo({ channel }: { channel: Channel }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground/5">
      {channel.logo !== "" && !broken ? (
        <img
          src={channel.logo}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="size-full object-contain p-1"
        />
      ) : (
        <span className="text-small font-medium">
          {channel.name.trim().slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}
