import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The title page's Back button (#117): a round button that floats at the
// window's top-left, clear of the sidebar and the title bar. Over the hero it
// is media glass (white on any art); once the page scrolls past the hero it
// turns to regular glass, so it reads over the page and the Episodes header.
// With no hero (loading, or an error) it is regular glass.
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
      variant="ghost"
      size="icon-lg"
      aria-label="Back"
      data-over-hero={overHero || undefined}
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/" }))}
      className={cn(
        "fixed start-[calc(var(--sidebar-inset)+var(--spacing-gutter))] top-[calc(var(--titlebar-h)+0.75rem)] z-20 size-10 rounded-full sm:size-10 transition-[color,background-color,scale] duration-(--duration-fast)",
        overHero
          ? "glass-media text-white hover:bg-(--glass-media) hover:text-white"
          : "glass text-popover-foreground hover:bg-(--glass-regular)",
      )}
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}
