import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The title page's Back button: a round button that floats under the top
// bar at the page's left edge. Over the hero it is media material (white on
// any art); once the page scrolls past the hero it takes the popup material,
// so it reads over the page.
export function BackButton({ hero }: { hero: Element | null }) {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const button = useRef<HTMLButtonElement | null>(null);
  const [past, setPast] = useState(false);

  // The hero is "past" once it no longer reaches the button's bottom edge:
  // the view starts there (the root margin cuts everything above it).
  useEffect(() => {
    const target = button.current;
    if (!hero || !target || typeof IntersectionObserver === "undefined") return undefined;
    const bottom = Math.ceil(target.getBoundingClientRect().bottom);
    const observer = new IntersectionObserver(
      (entries) => setPast(!entries[entries.length - 1]!.isIntersecting),
      { rootMargin: `-${bottom}px 0px 0px 0px` },
    );
    observer.observe(hero);
    return () => {
      observer.disconnect();
      setPast(false);
    };
  }, [hero]);

  const overHero = hero !== null && !past;
  return (
    <Button
      ref={button}
      variant={overHero ? "media" : "ghost"}
      size="icon-lg"
      aria-label="Back"
      data-over-hero={overHero || undefined}
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/" }))}
      className={cn(
        "fixed start-page top-[calc(var(--spacing-bar)+0.5rem)] z-20",
        !overHero && "material-pop text-popover-foreground hover:bg-popover",
      )}
    >
      <ChevronLeft className="size-5" strokeWidth={2.25} />
    </Button>
  );
}
