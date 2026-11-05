import type { ReactNode } from "react";

import { Ambient } from "@/components/media/ambient";
import { cn } from "@/lib/utils";

// The page the screens before a profile is in use share (#123): Sinag's
// lagoon glow behind the content, which is centred in the window. The `focus`
// chrome pads its pane by --titlebar-h, so the page pulls the glow up under
// the title bar's strip and pads the content back down.
export function FocusScreen({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="relative isolate -mt-(--titlebar-h) flex min-h-[calc(100%+var(--titlebar-h))] flex-col pt-(--titlebar-h)">
      <Ambient tone="brand" />
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

// A pill that presses in, for the large buttons on these screens (Apple TV's
// pattern: the main action solid, the others glass).
export const pillButton =
  "h-11 rounded-full px-6 text-base before:rounded-full transition-transform duration-(--duration-fast) motion-safe:active:scale-[0.97] sm:h-11 sm:text-base";

// The glass look for a ghost button: the tier's tint stays on hover (a
// hover:bg-* would replace it), and a faint wash marks the hover instead.
// Put it with variant="ghost".
export const glassButton =
  "glass border-transparent hover:bg-(--glass-regular) hover:before:bg-foreground/6 data-pressed:bg-(--glass-regular)";
