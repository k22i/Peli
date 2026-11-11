import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { useRovingItem } from "@/components/media/roving";
import { openOnContextKey, TitleMenu } from "@/components/media/title-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { MenuTitle } from "@/lib/title-actions";
import { cn } from "@/lib/utils";

export type CardProps = useRender.ComponentProps<"button"> & {
  title: string;
  // A line under the title: "2024 · 1h 52m", "S2 · E5".
  meta?: ReactNode | undefined;
  src?: string | undefined;
  // Shown under src while it loads, and if it fails: the art it replaces.
  fallbackSrc?: string | undefined;
  // How much has been watched, 0 to 1.
  progress?: number | undefined;
  // Top-left over the artwork: a coss Badge such as "New" or "4K".
  badge?: ReactNode | undefined;
  // Bottom-left over the artwork, on a dark lozenge: "S2 · E5".
  pill?: ReactNode | undefined;
  // The title the card stands for: with it, right-click (or the
  // context-menu key, or Shift+F10) opens the title's menu.
  menu?: MenuTitle | undefined;
  // Menu items to show in place of the title's own, such as the actions on
  // a selection when this card is part of one.
  menuItems?: ReactNode | undefined;
  // Part of a multi-selection: a sun ring round the art and a check on it.
  selected?: boolean | undefined;
};

// The art grows a little towards you on hover and focus, and its shadow
// deepens; focus draws the sun ring around the art, not the caption.
const frame =
  "relative overflow-hidden rounded-card bg-muted shadow-card transition-[scale,box-shadow,filter] duration-(--duration-base) ease-out-soft after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)] group-hover/card:shadow-float group-focus-visible/card:shadow-float group-focus-visible/card:outline-2 group-focus-visible/card:outline-offset-[3px] group-focus-visible/card:outline-ring motion-safe:group-hover/card:scale-[1.035] motion-safe:group-focus-visible/card:scale-[1.035] motion-safe:group-active/card:scale-[0.985]";

function Card({
  title,
  meta,
  src,
  fallbackSrc,
  progress,
  badge,
  pill,
  menu,
  menuItems,
  selected,
  shape,
  render,
  className,
  ...props
}: CardProps & { shape: "poster" | "landscape" }) {
  const rowItem = useRovingItem();

  const defaultProps = {
    type: render ? undefined : ("button" as const),
    className: cn(
      "group/card flex cursor-pointer flex-col gap-2.5 text-start outline-none",
      shape === "poster" ? "w-poster" : "w-landscape",
      className,
    ),
    "data-slot": `${shape}-card`,
    "data-selected": selected ? "" : undefined,
    onKeyDown: menu ? openOnContextKey : undefined,
    children: (
      <>
        <div
          className={cn(
            frame,
            shape === "poster" ? "aspect-[2/3]" : "aspect-video",
            selected && "outline-2 outline-offset-[3px] outline-sun",
          )}
        >
          <Artwork
            src={src}
            fallback={fallbackSrc}
            use={shape}
            title={title}
            showTitle
            titleClassName={shape === "landscape" ? "text-[1.625rem]" : undefined}
          />
          {(pill || progress !== undefined) && (
            <div className="absolute inset-x-0 bottom-0 h-2/5 bg-linear-to-t from-black/70 to-transparent" />
          )}
          {badge && <div className="absolute start-2 top-2 flex gap-1">{badge}</div>}
          {selected && (
            <span
              aria-hidden
              className="absolute end-2 top-2 grid size-6 place-items-center rounded-full bg-sun text-sun-foreground shadow-card"
            >
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          )}
          {pill && (
            <span
              className={cn(
                "absolute start-3 rounded-full bg-black/55 px-2 py-0.5 text-tiny font-semibold tracking-[0.02em] text-white tnum backdrop-blur-md",
                progress === undefined ? "bottom-3" : "bottom-5",
              )}
            >
              {pill}
            </span>
          )}
          {progress !== undefined && <WatchProgress value={progress} />}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 px-px">
          <span className="truncate type-item text-foreground/90 transition-colors group-hover/card:text-foreground">
            {title}
          </span>{" "}
          {meta && <span className="truncate text-small text-muted-foreground tnum">{meta}</span>}
        </div>
      </>
    ),
  };

  const card = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, rowItem, props),
    render,
  });
  return menu ? (
    <TitleMenu title={menu} items={menuItems}>
      {card}
    </TitleMenu>
  ) : (
    card
  );
}

// A 2:3 poster with the title and a meta line under it.
export function PosterCard(props: CardProps) {
  return <Card shape="poster" {...props} />;
}

// A 16:9 still for Continue Watching and episodes.
export function LandscapeCard(props: CardProps) {
  return <Card shape="landscape" {...props} />;
}

// How much is watched: a hairline of sunlight along the bottom of the art.
// Art is dark in either theme, so the track is always light-on-dark.
export function WatchProgress({ value, className }: { value: number; className?: string }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <>
      <div
        aria-hidden
        className={cn("absolute inset-x-3 bottom-2.5 h-[3px] rounded-full bg-white/25", className)}
      >
        <div
          className="h-full rounded-full bg-[#ffb547] shadow-[0_0_8px_rgb(255_181_71/0.6)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="sr-only">{percent}% watched</span>
    </>
  );
}

export function PosterCardSkeleton() {
  return <CardSkeleton shape="poster" />;
}

export function LandscapeCardSkeleton() {
  return <CardSkeleton shape="landscape" />;
}

function CardSkeleton({ shape }: { shape: "poster" | "landscape" }) {
  return (
    <div
      aria-hidden
      className={cn("flex flex-col gap-2.5", shape === "poster" ? "w-poster" : "w-landscape")}
    >
      <Skeleton
        className={cn("rounded-card", shape === "poster" ? "aspect-[2/3]" : "aspect-video")}
      />
      <div className="flex flex-col gap-1.5 px-px">
        <Skeleton className="h-3 w-3/4 rounded-full" />
        <Skeleton className="h-2.5 w-1/3 rounded-full" />
      </div>
    </div>
  );
}
