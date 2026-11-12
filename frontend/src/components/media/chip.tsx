import type { ComponentProps } from "react";

import { ScrollRail } from "@/components/media/scroll-rail";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

// A pill-shaped filter (genre, year, quality): coss's Toggle, tinted with the
// brand colour when on.
export function Chip({ className, ...props }: ComponentProps<typeof Toggle>) {
  return (
    <Toggle
      className={cn(
        "hit-area h-8 shrink-0 rounded-full border-transparent bg-foreground/6 px-3.5 text-small font-[560] text-foreground/75 transition-[color,background-color,scale] duration-(--duration-fast) ease-out-soft before:rounded-full hover:bg-foreground/10 hover:text-foreground data-pressed:bg-foreground data-pressed:text-background data-pressed:hover:bg-foreground motion-safe:active:scale-95 sm:h-8",
        className,
      )}
      {...props}
    />
  );
}

// A wrapping set of Chips; `multiple` for multi-select filters.
export function ChipGroup({ className, ...props }: ComponentProps<typeof ToggleGroup>) {
  return <ToggleGroup className={cn("flex-wrap gap-2", className)} {...props} />;
}

// The same set on one line that scrolls sideways (#116), for a long list such
// as a profile's catalogs. The pressed chip is brought into view on mount.
export function ChipRail({
  className,
  railClassName,
  ...props
}: ComponentProps<typeof ToggleGroup> & { railClassName?: string }) {
  return (
    <ScrollRail revealSelector="[data-pressed]" className={railClassName}>
      <ToggleGroup className={cn("shrink-0 flex-nowrap gap-2", className)} {...props} />
    </ScrollRail>
  );
}
