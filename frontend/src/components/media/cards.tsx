import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { useRovingItem } from "@/components/media/roving";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type CardProps = useRender.ComponentProps<"button"> & {
  title: string;
  // A line under the title, set in mono: "2024 · 1h 52m", "S2 · E5".
  meta?: ReactNode | undefined;
  src?: string | undefined;
  // How much has been watched, 0 to 1.
  progress?: number | undefined;
  // Top-left over the artwork: a coss Badge such as "New" or "4K".
  badge?: ReactNode | undefined;
};

// The artwork lifts on hover and focus (Apple TV) and the focus ring is drawn
// around it rather than around the whole card.
const frame =
  "relative overflow-hidden rounded-xl bg-muted shadow-card transition-[translate,scale,box-shadow] duration-(--duration-base) ease-spring after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/8 after:ring-inset dark:after:ring-white/8 group-hover/card:shadow-lift group-focus-visible/card:shadow-lift group-focus-visible/card:outline-2 group-focus-visible/card:outline-offset-3 group-focus-visible/card:outline-ring motion-safe:group-hover/card:-translate-y-1 motion-safe:group-hover/card:scale-[1.03] motion-safe:group-focus-visible/card:scale-[1.03] motion-safe:group-active/card:scale-[0.98]";

function Card({
  title,
  meta,
  src,
  progress,
  badge,
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
    children: (
      <>
        <div className={cn(frame, shape === "poster" ? "aspect-[2/3]" : "aspect-video")}>
          <Artwork
            src={src}
            title={title}
            showTitle
            // Above the scrim, clear of the progress bar.
            titleClassName={progress === undefined ? undefined : "z-10 pb-6"}
          />
          {shape === "landscape" && progress !== undefined && (
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-black/60 to-transparent" />
          )}
          {badge && <div className="absolute start-2 top-2 flex gap-1">{badge}</div>}
          {progress !== undefined && <WatchProgress value={progress} />}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {meta && (
            <span className="truncate font-mono text-meta text-muted-foreground">{meta}</span>
          )}
        </div>
      </>
    ),
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, rowItem, props),
    render,
  });
}

// A 2:3 poster with the title and a meta line under it.
export function PosterCard(props: CardProps) {
  return <Card shape="poster" {...props} />;
}

// A 16:9 still for Continue Watching and episodes.
export function LandscapeCard(props: CardProps) {
  return <Card shape="landscape" {...props} />;
}

// The brand-coloured bar along the bottom of the artwork. Artwork is dark in
// either theme, so the bar always takes dark mode's brighter brand colour.
export function WatchProgress({ value, className }: { value: number; className?: string }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <>
      <div
        aria-hidden
        className={cn(
          "dark absolute inset-x-2.5 bottom-2.5 h-1 overflow-hidden rounded-full bg-white/30 backdrop-blur-sm",
          className,
        )}
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
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
        className={cn("rounded-xl", shape === "poster" ? "aspect-[2/3]" : "aspect-video")}
      />
      <div className="flex flex-col gap-1.5 px-0.5">
        <Skeleton className="h-3.5 w-3/4 rounded-sm" />
        <Skeleton className="h-3 w-1/2 rounded-sm" />
      </div>
    </div>
  );
}
