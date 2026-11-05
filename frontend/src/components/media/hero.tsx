import { Children, useState, type ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { Skeleton } from "@/components/ui/skeleton";
import { sharper } from "@/lib/artwork-url";
import { cn } from "@/lib/utils";

// The billboard at the top of Home and the detail pages: a backdrop with the
// title, a mono meta line, the synopsis and actions over a scrim.
//
// The content is always dark (the `.dark` scope), whatever the theme, so its
// text and buttons read on any artwork. In dark mode the default hero runs
// edge to edge and fades into the page (Nuvio); in light mode it's an inset,
// rounded billboard, since a dark-to-white fade turns muddy.
//
// `size="feature"` (Home, #115) is taller and full-bleed in both themes: the
// art runs under the floating sidebar and the title bar, the text starts
// clear of the sidebar, and a long fade (with a middle stop, so it isn't
// muddy in light mode) melts the bottom into the page.
export type HeroSize = "default" | "feature";

export function Hero({
  title,
  logo,
  eyebrow,
  meta,
  synopsis,
  backdrop,
  fallbackBackdrop,
  actions,
  size = "default",
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
  size?: HeroSize;
  className?: string;
}) {
  const feature = size === "feature";
  return (
    <section
      aria-label={title}
      className={cn(
        "relative",
        // The page colour, resolved here (outside the `.dark` scope) for the
        // fade drawn inside it.
        feature ? "bleed [--fade:var(--background)]" : "px-gutter pt-4 dark:px-0 dark:pt-0",
        className,
      )}
    >
      {/* The frame follows the theme; the `.dark` scope inside it doesn't
          (a `dark:` utility on the scope itself would always match). */}
      <div
        className={cn(
          "overflow-hidden",
          !feature && "rounded-2xl shadow-lift dark:rounded-none dark:shadow-none",
        )}
      >
        <div
          className={cn(
            "dark relative isolate flex items-end text-foreground",
            feature ? "min-h-[min(80vh,46rem)]" : "min-h-[min(68vh,36rem)]",
          )}
        >
          <Artwork
            src={backdrop}
            fallback={fallbackBackdrop}
            title={title}
            className="absolute inset-0 -z-10"
          />
          {/* Scrims: from the bottom and from the start, where the text sits. */}
          <div className="absolute inset-0 -z-10 bg-linear-to-t from-black/85 via-black/35 to-black/0" />
          <div
            className={cn(
              "absolute inset-0 -z-10 bg-linear-to-r to-transparent",
              feature ? "from-black/75 via-black/30" : "from-black/70 via-black/20",
            )}
          />

          {/* The feature's fade sits with the scrims, under the text. */}
          {feature && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-32 bg-linear-to-t from-(--fade) via-(--fade)/60 to-transparent" />
          )}

          <div
            className={cn(
              feature
                ? "w-full pe-gutter ps-[calc(var(--sidebar-inset)+var(--spacing-gutter))] pt-32 pb-16"
                : "max-w-2xl px-gutter pt-24 pb-12",
            )}
          >
            <div className={cn("flex flex-col gap-4", feature && "max-w-3xl")}>
              {eyebrow && (
                <p className="font-mono text-meta font-medium tracking-widest text-brand uppercase">
                  {eyebrow}
                </p>
              )}
              <h1 className="font-heading text-display text-balance font-stretch-expanded">
                {logo ? (
                  <Logo
                    src={logo}
                    title={title}
                    className={feature ? "max-h-40 max-w-[min(34rem,100%)]" : undefined}
                  />
                ) : (
                  title
                )}
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
                <p
                  className={cn(
                    "line-clamp-3 text-pretty text-foreground/85",
                    feature ? "max-w-2xl" : "max-w-xl",
                  )}
                >
                  {synopsis}
                </p>
              )}
              {actions && <div className="mt-2 flex flex-wrap items-center gap-3">{actions}</div>}
            </div>
          </div>
        </div>
      </div>
      {/* Dark mode: melt the default hero's bottom edge into the page. */}
      {!feature && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-12 bg-linear-to-t from-background to-transparent dark:block" />
      )}
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
  className?: string | undefined;
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

export function HeroSkeleton({
  size = "default",
  className,
}: {
  size?: HeroSize;
  className?: string;
}) {
  const feature = size === "feature";
  return (
    <div
      aria-hidden
      className={cn(feature ? "bleed" : "px-gutter pt-4 dark:px-0 dark:pt-0", className)}
    >
      <div
        className={cn(
          "flex items-end bg-muted",
          feature
            ? "min-h-[min(80vh,46rem)]"
            : "min-h-[min(68vh,36rem)] rounded-2xl dark:rounded-none",
        )}
      >
        <div
          className={cn(
            "w-full",
            feature
              ? "pe-gutter ps-[calc(var(--sidebar-inset)+var(--spacing-gutter))] pt-32 pb-16"
              : "max-w-2xl px-gutter pt-24 pb-12",
          )}
        >
          <div className={cn("flex flex-col gap-4", feature && "max-w-3xl")}>
            <Skeleton className="h-3 w-28 rounded-sm" />
            <Skeleton className="h-14 w-4/5 rounded-lg" />
            <Skeleton className="h-3 w-56 rounded-sm" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-2/3 rounded-sm" />
            </div>
            <div className="mt-2 flex gap-3">
              <Skeleton className={cn("h-10 w-28", feature ? "rounded-full" : "rounded-lg")} />
              <Skeleton className={cn("h-10 w-32", feature ? "rounded-full" : "rounded-lg")} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
