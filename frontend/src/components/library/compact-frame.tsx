import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// The Library page on an iPhone (#132; the compact iOS shell, see
// useCompactShell). The iOS navigation-bar pattern instead of Browse's
// shrinking header: a 34 pt large title on its own row with Sort at its end,
// the full-width view switch under it, then the type chips and, when the
// sort isn't the default, a caption saying which it is. Once the large title
// has scrolled under, a 44 pt glass bar with the title at 17 pt, centred,
// sticks under the top strip.
//
// The bar's measured height is --library-header-h on the page, which the
// Upcoming view's sticky day headers add to --spacing-bar (a calc on iOS,
// so it is never parsed; see ios-port). On an iPhone on its side
// (ios-short) the bar is gone, as Browse's header goes static there, and the
// day headers stick right under the top strip.
//
// The page gutter is 16 pt here (plus the side insets on its side), so three
// posters fit across.
export function CompactLibraryFrame({
  title,
  switcher,
  sort,
  rail,
  caption,
  children,
}: {
  title: string;
  switcher: ReactNode;
  // The Sort button at the end of the title row (Titles only).
  sort?: ReactNode;
  rail?: ReactNode;
  caption?: string | undefined;
  children: ReactNode;
}) {
  const page = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const element = bar.current;
    const root = page.current;
    if (!element || !root) return undefined;
    const write = () => root.style.setProperty("--library-header-h", `${element.offsetHeight}px`);
    write();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The small title shows once the large one is wholly under the bar: the
  // view's top edge is the bar's bottom edge.
  useEffect(() => {
    const target = heading.current;
    const element = bar.current;
    if (!target || !element || typeof IntersectionObserver === "undefined") return undefined;
    const top = Number.parseFloat(getComputedStyle(element).top) || 0;
    const observer = new IntersectionObserver(
      (entries) => setCollapsed(!entries[entries.length - 1]!.isIntersecting),
      { rootMargin: `-${top + element.offsetHeight}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={page}
      data-slot="compact-library"
      className="relative flex flex-col pb-6 [--spacing-page:calc(1rem+max(env(safe-area-inset-left),env(safe-area-inset-right)))]"
    >
      {/* Takes no room (-mb-11): it lies over the title row until it sticks,
          and holds nothing to tap, so the Sort button under it still works. */}
      <div
        ref={bar}
        aria-hidden
        data-collapsed={collapsed || undefined}
        className="group/bar pointer-events-none sticky top-(--spacing-bar) z-10 -mb-11 flex h-11 items-center justify-center transition-[background-color,box-shadow] duration-(--duration-base) ios-short:hidden data-collapsed:material-bar data-collapsed:shadow-[0_1px_0_var(--border)]"
      >
        <span className="text-[1.0625rem] font-[590] opacity-0 transition-opacity duration-(--duration-fast) group-data-collapsed/bar:opacity-100">
          {title}
        </span>
      </div>
      <header className="mb-4 flex flex-col gap-3 pt-1">
        <div className="flex min-h-11 items-center justify-between gap-3 px-page">
          <h1
            ref={heading}
            className="font-display text-[2.125rem] leading-[1.1] tracking-[-0.01em]"
          >
            {title}
          </h1>
          {sort && <div className="-me-2 shrink-0">{sort}</div>}
        </div>
        <div className="px-page">{switcher}</div>
        {rail}
        {caption && (
          <p className="-mt-1 px-page text-tiny text-muted-foreground" aria-live="polite">
            {caption}
          </p>
        )}
      </header>
      {children}
    </div>
  );
}
