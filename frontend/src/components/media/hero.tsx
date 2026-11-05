import { Children, useState, type ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { Skeleton } from "@/components/ui/skeleton";
import { sharper } from "@/lib/artwork-url";
import { cn } from "@/lib/utils";

// The billboard at the top of Home and the detail pages: a backdrop with the
// title, a mono meta line, the synopsis and actions over a scrim.
//
// The content is always dark (the `.dark` scope), whatever the theme, so its
// text and buttons read on any artwork. In dark mode the hero runs edge to
// edge and fades into the page (Nuvio); in light mode it's an inset,
// rounded billboard, since a dark-to-white fade turns muddy.
export function Hero({
  title,
  logo,
  eyebrow,
  meta,
  synopsis,
  backdrop,
  fallbackBackdrop,
  actions,
  className,
}: {
  title: string;
  // The title's logo, drawn in place of its name (title pages); the name
  // shows if it fails to load.
  logo?: string | undefined;
  // A short line above the title: "New season", "Continue watching".
  eyebrow?: ReactNode;
  // Year, runtime, rating…, joined with middots; coss Badges also fit here.
  meta?: ReactNode[];
  synopsis?: ReactNode;
  backdrop?: string | undefined;
  // Shown under the backdrop while it loads or if it fails.
  fallbackBackdrop?: string | undefined;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("relative px-gutter pt-4 dark:px-0 dark:pt-0", className)}
    >
      {/* The frame follows the theme; the `.dark` scope inside it doesn't
          (a `dark:` utility on the scope itself would always match). */}
      <div className="overflow-hidden rounded-2xl shadow-lift dark:rounded-none dark:shadow-none">
        <div className="dark relative isolate flex min-h-[min(68vh,36rem)] items-end text-foreground">
          <Artwork
            src={backdrop}
            fallback={fallbackBackdrop}
            title={title}
            className="absolute inset-0 -z-10"
          />
          {/* Scrims: from the bottom and from the start, where the text sits. */}
          <div className="absolute inset-0 -z-10 bg-linear-to-t from-black/85 via-black/35 to-black/0" />
          <div className="absolute inset-0 -z-10 bg-linear-to-r from-black/70 via-black/20 to-transparent" />

          <div className="flex max-w-2xl flex-col gap-4 px-gutter pt-24 pb-12">
            {eyebrow && (
              <p className="font-mono text-meta font-medium tracking-widest text-brand uppercase">
                {eyebrow}
              </p>
            )}
            <h1 className="font-heading text-display text-balance font-stretch-expanded">
              {logo ? <Logo src={logo} title={title} /> : title}
            </h1>
            {meta && meta.length > 0 && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-meta text-foreground/80">
                {Children.map(meta, (item, index) => (
                  <span className="flex items-center gap-2">
                    {index > 0 && <span aria-hidden>·</span>}
                    {item}
                  </span>
                ))}
              </p>
            )}
            {synopsis && (
              <p className="line-clamp-3 max-w-xl text-pretty text-foreground/85">{synopsis}</p>
            )}
            {actions && <div className="mt-2 flex flex-wrap items-center gap-3">{actions}</div>}
          </div>
        </div>
      </div>
      {/* Dark mode: melt the hero's bottom edge into the page. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-12 bg-linear-to-t from-background to-transparent dark:block" />
    </section>
  );
}

// A title's logo; its name if the logo fails to load. Folder pages share it.
export function Logo({
  src,
  title,
  className,
}: {
  src: string;
  title: string;
  className?: string;
}) {
  // The sharper logo (#113) first; the one the addon named if that fails;
  // the title's name if both do.
  const [failed, setFailed] = useState<string[]>([]);
  if (failed.includes(src)) return title;
  const sharp = sharper(src, "logo") ?? src;
  const shown = failed.includes(sharp) ? src : sharp;
  return (
    <img
      src={shown}
      alt={title}
      onError={() => setFailed([...failed, shown])}
      className={cn(
        "max-h-32 max-w-[min(28rem,100%)] object-contain object-left drop-shadow-lg",
        className,
      )}
    />
  );
}

export function HeroSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("px-gutter pt-4 dark:px-0 dark:pt-0", className)}>
      <div className="flex min-h-[min(68vh,36rem)] items-end rounded-2xl bg-muted dark:rounded-none">
        <div className="flex w-full max-w-2xl flex-col gap-4 px-gutter pt-24 pb-12">
          <Skeleton className="h-3 w-28 rounded-sm" />
          <Skeleton className="h-14 w-4/5 rounded-lg" />
          <Skeleton className="h-3 w-56 rounded-sm" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full rounded-sm" />
            <Skeleton className="h-4 w-2/3 rounded-sm" />
          </div>
          <div className="mt-2 flex gap-3">
            <Skeleton className="h-10 w-28 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
