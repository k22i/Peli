import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// The surface every prompt over the video shares (resume, skip, up next):
// warm near-black glass with a hairline, so they read as one family wherever
// the frame is bright. They live in one stack, the player's prompt rail.
export const promptSurface =
  "rounded-2xl bg-[rgb(20_18_16/0.78)] text-white shadow-[0_18px_48px_-12px_rgb(0_0_0/0.7)] ring-1 ring-white/10 backdrop-blur-2xl backdrop-saturate-150";

// A prompt's way in: it rises a little and fades, from the rail.
export const promptEnter =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300";

// A one-line prompt: an icon, what happened, and its action.
export function Prompt({
  icon,
  children,
  action,
  className,
  ...props
}: {
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      className={cn(
        promptSurface,
        promptEnter,
        "flex items-center gap-3 py-2 ps-4 pe-2",
        className,
      )}
      {...props}
    >
      {icon && <span className="text-white/60 [&_svg]:size-4">{icon}</span>}
      <p className="min-w-0 flex-1 text-small font-[560]">{children}</p>
      {action}
    </div>
  );
}
