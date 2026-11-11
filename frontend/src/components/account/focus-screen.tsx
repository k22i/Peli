import type { ReactNode } from "react";

import { Ambient } from "@/components/media/ambient";
import { cn } from "@/lib/utils";

// The page the screens before a profile is in use share: a sunrise along
// the bottom of the window and the content centred above it.
export function FocusScreen({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-full flex-col pt-bar">
      <Ambient tone="sun" />
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col justify-center gap-8 px-6 py-12",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

// The large capsule for these screens' actions.
export const pillButton =
  "h-12 px-6 text-[0.9375rem] [&_svg:not([class*='size-'])]:size-[1.125rem]";

// The quieter actions beside the main one: a soft tint of ink. Put it with
// variant="ghost".
export const glassButton = "bg-foreground/7 hover:bg-foreground/12 data-pressed:bg-foreground/12";
