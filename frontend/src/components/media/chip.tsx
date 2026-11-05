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
        "h-8 shrink-0 rounded-full border-border px-3.5 text-sm text-muted-foreground transition-[color,background-color,border-color,scale] duration-(--duration-fast) ease-smooth before:rounded-full hover:bg-accent hover:text-foreground data-pressed:border-transparent data-pressed:bg-brand-soft data-pressed:text-brand motion-safe:active:scale-95 sm:h-8",
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
