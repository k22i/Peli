import {
  Children,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Artwork } from "@/components/media/artwork";
import { useArtUnderBar } from "@/components/shell/bar-tone";
import { Skeleton } from "@/components/ui/skeleton";
import { isBright, isDarkLogo, regionTone, useArtTone, type Region } from "@/lib/art-tone";
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
  // The phone keeps a third of the screen for the rows below, and the room
  // for the marquee's buttons and dashes under the synopsis (routes/index.tsx).
  feature: "min-h-[min(84vh,50rem)] ios-compact:min-h-[min(68vh,34rem)]",
  // The phone: 52 % of the screen (#136), the text starting under the bar row.
  title: "min-h-[min(74vh,44rem)] ios-compact:min-h-[52svh]",
  default: "min-h-[min(56vh,30rem)]",
};

// The shade behind the text (#B, contrast). Wide: from the start edge,
// ~85 % black behind the text column, gone by about 60 % of the width.
// Compact (the phone): the text runs the full width, so it's shaded from
// the bottom instead. `--text-x` is where the text column starts.
const shade: Record<"wide" | "compact", string> = {
  wide: "linear-gradient(90deg, rgb(0 0 0/0.85), rgb(0 0 0/0.8) calc(var(--text-x) + 22rem), rgb(0 0 0/0.55) calc(var(--text-x) + 38rem), transparent max(60%, calc(var(--text-x) + 50rem)))",
  compact: "linear-gradient(0deg, rgb(0 0 0/0.85), rgb(0 0 0/0.75) 45%, transparent 80%)",
};
// On top over bright art, or art that can't be read (the safe side).
const brightShade: Record<"wide" | "compact", string> = {
  wide: "linear-gradient(90deg, rgb(0 0 0/0.5), rgb(0 0 0/0.45) calc(var(--text-x) + 38rem), transparent max(72%, calc(var(--text-x) + 60rem)))",
  compact: "linear-gradient(0deg, rgb(0 0 0/0.5), rgb(0 0 0/0.4) 50%, transparent 85%)",
};
const bottomShade = "linear-gradient(0deg, rgb(0 0 0/0.7), rgb(0 0 0/0.3) 35%, transparent 65%)";

// Small light text over art: a faint shadow keeps its edges off bright pixels.
const textShadow = "[text-shadow:0_1px_2px_rgb(0_0_0/0.45)]";

// The hero's row of actions. The same in the slide and in Home's marquee
// overlay, which draws the real buttons over the slides (routes/index.tsx):
// they have to lay out alike, or the buttons land outside the room the slide
// kept for them. A 320 pt phone has 296 pt for them, and Play, Details and
// Surprise take 311 at the ordinary padding, so they lose some there rather
// than wrap onto a second row that the floating tab bar would cover.
export const heroActions =
  "flex max-w-2xl flex-wrap items-center gap-2.5 ios-compact:w-full max-[359.98px]:gap-2 max-[359.98px]:[&_[data-slot=button]]:px-4";

const regionKeys = ["aspect", "x0", "x1", "y0", "y1"] as const;

// Where the text column sits over the art, measured, so the backdrop's
// brightness is read behind the text and not across the whole image.
function useTextRegion() {
  const frame = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<Region>();
  useEffect(() => {
    const box = frame.current;
    const text = column.current;
    if (!box || !text || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const outer = box.getBoundingClientRect();
      const inner = text.getBoundingClientRect();
      if (outer.width === 0 || outer.height === 0) return;
      const next: Region = {
        aspect: outer.width / outer.height,
        x0: (inner.left - outer.left) / outer.width,
        x1: (inner.right - outer.left) / outer.width,
        y0: (inner.top - outer.top) / outer.height,
        y1: (inner.bottom - outer.top) / outer.height,
      };
      setRegion((last) =>
        last && regionKeys.every((key) => Math.abs(last[key] - next[key]) < 0.02) ? last : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);
  return { frame, column, region };
}

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
  const { frame, column, region } = useTextRegion();
  // Bright behind the text, unreadable, or not read yet: shade harder.
  const tone = useArtTone(backdrop, "backdrop");
  const bright = !tone || !region || isBright(regionTone(tone, region));
  const shape = compactShell ? "compact" : "wide";
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
        ref={frame}
        data-art-tone={tone === undefined ? "reading" : bright ? "bright" : "dark"}
        className={cn(
          "dark relative isolate flex items-end overflow-hidden text-foreground",
          bleeds ? "[--text-x:var(--spacing-page)]" : "[--text-x:2.5rem]",
          !bleeds && "rounded-3xl shadow-float",
          compact ? "min-h-80" : heights[size],
        )}
      >
        <Artwork
          src={backdrop}
          // Only iOS rewrites a backdrop (#128): the desktop has no size for it.
          use="backdrop"
          fallback={fallbackBackdrop}
          title={title}
          className="absolute inset-0 -z-10 motion-safe:animate-[hero-settle_1.6s_var(--ease-out-soft)_both]"
        />
        {/* Scrims: shade behind the text column, more over bright art,
            from the bottom, and the fade into the page. */}
        <div
          data-slot="hero-shade"
          className="absolute inset-0 -z-10"
          style={{ backgroundImage: shade[shape] }}
        />
        <div
          data-slot="hero-bright-shade"
          className={cn(
            "absolute inset-0 -z-10 transition-opacity duration-(--duration-slow) ease-out-soft",
            !bright && "opacity-0",
          )}
          style={{ backgroundImage: brightShade[shape] }}
        />
        <div className="absolute inset-0 -z-10" style={{ backgroundImage: bottomShade }} />
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
          <div ref={column} className="flex max-w-2xl min-w-0 flex-col gap-4">
            {eyebrow && (
              // White to read on any art; the sun stays as the dot.
              <p className={cn("flex items-center gap-2 type-eyebrow text-white/90", textShadow)}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sun" />
                {eyebrow}
              </p>
            )}
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
                <p
                  className={cn(
                    "line-clamp-3 max-w-xl text-[0.9375rem] leading-relaxed text-pretty text-white/90",
                    textShadow,
                  )}
                >
                  {synopsis}
                </p>
              ))}
            {actions && (
              <div data-slot="hero-actions" className={cn("mt-2", heroActions)}>
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
          "text-[0.9375rem] leading-relaxed text-pretty text-white/90",
          textShadow,
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
        "flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small font-[510] text-white/90 tnum",
        textShadow,
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
  // A logo in near-black ink would vanish on the shade: show it in white.
  const tone = useArtTone(src, "logo");
  const silhouette = tone ? isDarkLogo(tone) : false;
  if (failed.includes(src)) return title;
  const sharp = sharper(src, "logo") ?? src;
  const shown = failed.includes(sharp) ? src : sharp;
  return (
    <img
      decoding="async"
      src={viaProxy(shown)}
      alt={title}
      onError={() => setFailed([...failed, shown])}
      data-silhouette={silhouette || undefined}
      className={cn(
        "max-h-28 max-w-[min(26rem,100%)] object-contain object-left drop-shadow-[0_4px_24px_rgb(0_0_0/0.5)]",
        silhouette && "brightness-0 invert",
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
