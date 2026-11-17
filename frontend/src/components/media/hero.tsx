import { Children, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { Artwork } from "@/components/media/artwork";
import { useArtUnderBar } from "@/components/shell/bar-tone";
import { Skeleton } from "@/components/ui/skeleton";
import { sharper, viaProxy } from "@/lib/artwork-url";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// feature  Home's marquee: the whole window's width, pulled up under the top
//          bar, most of the window tall
// title    a title page's backdrop: the same, a little shorter
// default  a framed banner inside the page (folders)
export type HeroSize = "default" | "feature" | "title";

const bled = (size: HeroSize) => size !== "default";

const heights: Record<HeroSize, string> = {
  feature: "min-h-[min(84vh,50rem)] ios-compact:min-h-[min(64vh,32rem)]",
  // The phone: 52 % of the screen (#136), the text starting under the bar row.
  title: "min-h-[min(74vh,44rem)] ios-compact:min-h-[52svh]",
  default: "min-h-[min(56vh,30rem)]",
};

// Art with its story set over the lower left: an eyebrow, the title (the
// show's logo when there is one, else the display serif), a meta line, the
// synopsis and actions. Always light-on-dark, whatever the theme. The bled
// sizes melt into the page at the bottom.
export function Hero({
  title,
  logo,
  eyebrow,
  meta,
  synopsis,
  backdrop,
  fallbackBackdrop,
  actions,
  aside,
  metaRaw = false,
  size = "default",
  compact = false,
  className,
  ref,
}: {
  title: string;
  logo?: string | undefined;
  eyebrow?: ReactNode;
  meta?: ReactNode[];
  synopsis?: ReactNode;
  backdrop?: string | undefined;
  fallbackBackdrop?: string | undefined;
  actions?: ReactNode;
  // Bottom-right, level with the actions (Home's page dots).
  aside?: ReactNode;
  // `meta` is one ready-made line (a MetaLine of its own), not items.
  metaRaw?: boolean;
  size?: HeroSize;
  compact?: boolean;
  className?: string;
  ref?: Ref<HTMLElement>;
}) {
  const bleeds = bled(size);
  useArtUnderBar(bleeds);
  const compactShell = useCompactShell();
  const phoneTitle = size === "title" && compactShell;
  return (
    <section
      ref={ref}
      aria-label={title}
      className={cn(
        // The fade into the page: long into the dark canvas, short into
        // paper, where it would wash out the text over it.
        "relative [--fade-h:4.5rem] [--fade:var(--background)] dark:[--fade-h:10rem]",
        bleeds ? "under-bar" : "px-page pt-2",
        className,
      )}
    >
      <div
        className={cn(
          "dark relative isolate flex items-end overflow-hidden text-foreground",
          !bleeds && "rounded-3xl shadow-float",
          compact ? "min-h-80" : heights[size],
        )}
      >
        <Artwork
          src={backdrop}
          fallback={fallbackBackdrop}
          title={title}
          className="absolute inset-0 -z-10 motion-safe:animate-[hero-settle_1.6s_var(--ease-out-soft)_both]"
        />
        {/* Scrims: a deep pool of shadow under the text at the lower left,
            and the fade into the page. */}
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(120%_90%_at_0%_100%,rgb(0_0_0/0.82),rgb(0_0_0/0.35)_45%,transparent_75%)]" />
        <div className="absolute inset-0 -z-10 bg-linear-to-t from-black/60 via-transparent to-transparent" />
        {bleeds && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-(--fade-h) bg-linear-to-t from-(--fade) via-(--fade)/70 to-transparent" />
        )}

        <div
          className={cn(
            "flex w-full items-end justify-between gap-8 ios-compact:flex-col ios-compact:items-start ios-compact:gap-5",
            bleeds
              ? "px-page pt-40 pb-14 ios-compact:pt-28 ios-compact:pb-10"
              : "px-8 pt-24 pb-9 sm:px-10",
            // One bar row (Back | avatar) sits above the text, not over it.
            size === "title" && "ios-compact:pt-[calc(var(--spacing-bar)+0.5rem)]",
          )}
        >
          <div className="flex max-w-2xl min-w-0 flex-col gap-4">
            {eyebrow && <p className="type-eyebrow text-[#ffc46b]">{eyebrow}</p>}
            <h1 className={cn("text-white", bleeds ? "type-hero" : "type-display")}>
              {logo ? (
                <Logo
                  src={logo}
                  title={title}
                  className={
                    size === "feature"
                      ? "max-h-36 max-w-[min(30rem,100%)] ios-compact:max-h-24"
                      : size === "title"
                        ? "max-h-32 max-w-[min(28rem,100%)] ios-compact:max-h-24 ios-compact:max-w-[70%]"
                        : undefined
                  }
                />
              ) : (
                title
              )}
            </h1>
            {meta && meta.length > 0 && (metaRaw ? meta : <MetaLine items={meta} />)}
            {synopsis &&
              (phoneTitle && typeof synopsis === "string" ? (
                <Overview key={synopsis} text={synopsis} />
              ) : (
                <p className="line-clamp-3 max-w-xl text-[0.9375rem] leading-relaxed text-pretty text-white/78">
                  {synopsis}
                </p>
              ))}
            {actions && (
              <div className="mt-2 flex flex-wrap items-center gap-2.5 ios-compact:w-full ios-compact:flex-nowrap">
                {actions}
              </div>
            )}
          </div>
          {aside && <div className="shrink-0 pb-1">{aside}</div>}
        </div>
      </div>
    </section>
  );
}

// The phone's overview (#136): three lines, and "More" when there is more.
function Overview({ text }: { text: string }) {
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (element && !open) setClipped(element.scrollHeight > element.clientHeight + 1);
  }, [open]);
  return (
    <div className="flex max-w-xl flex-col items-start gap-1">
      <p
        ref={paragraph}
        id="overview"
        className={cn(
          "text-[0.9375rem] leading-relaxed text-pretty text-white/78",
          !open && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls="overview"
          onClick={() => setOpen(!open)}
          className="-my-2 min-h-11 text-[0.9375rem] font-[620] text-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

// "2024 · 8.4 · Drama · Comedy" in small caps-height text, the separators
// set as faint dots.
export function MetaLine({ items, className }: { items: ReactNode[]; className?: string }) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small font-[510] text-white/75 tnum",
        className,
      )}
    >
      {Children.map(items, (item, index) => (
        <span className="flex items-center gap-2.5">
          {index > 0 && <span aria-hidden className="size-[3px] rounded-full bg-current/60" />}
          {item}
        </span>
      ))}
    </p>
  );
}

// IMDb's own yellow tag, then the score.
export function ImdbScore({ rating }: { rating: string }) {
  return (
    <span data-testid="imdb-score" className="inline-flex items-center gap-1.5">
      <span className="rounded-[3px] bg-[#f5c518] px-1 py-px text-[0.5625rem] leading-none font-black tracking-tight text-black">
        IMDb
      </span>{" "}
      {rating}
    </span>
  );
}

export function Logo({
  src,
  title,
  className,
}: {
  src: string;
  title: string;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  if (failed.includes(src)) return title;
  const sharp = sharper(src, "logo") ?? src;
  const shown = failed.includes(sharp) ? src : sharp;
  return (
    <img
      src={viaProxy(shown)}
      alt={title}
      onError={() => setFailed([...failed, shown])}
      className={cn(
        "max-h-28 max-w-[min(26rem,100%)] object-contain object-left drop-shadow-[0_4px_24px_rgb(0_0_0/0.5)]",
        className,
      )}
    />
  );
}

export function HeroSkeleton({
  size = "default",
  compact = false,
  className,
}: {
  size?: HeroSize;
  compact?: boolean;
  className?: string;
}) {
  const bleeds = bled(size);
  useArtUnderBar(bleeds);
  return (
    <div aria-hidden className={cn(bleeds ? "under-bar" : "px-page pt-2", className)}>
      <div
        className={cn(
          "flex items-end bg-muted",
          !bleeds && "rounded-3xl",
          compact ? "min-h-80" : heights[size],
        )}
      >
        <div className={cn("w-full", bleeds ? "px-page pt-40 pb-14" : "px-10 pt-24 pb-9")}>
          <div className="flex max-w-2xl flex-col gap-4">
            <Skeleton className="h-2.5 w-24 rounded-full" />
            <Skeleton className="h-16 w-3/4 rounded-xl" />
            <Skeleton className="h-3 w-52 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-full rounded-full" />
              <Skeleton className="h-3.5 w-2/3 rounded-full" />
            </div>
            <div className="mt-2 flex gap-2.5">
              <Skeleton className="h-11 w-32 rounded-full" />
              <Skeleton className="h-11 w-11 rounded-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
