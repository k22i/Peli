import { useId } from "react";

import { cn } from "@/lib/utils";

// Peli's mark: a pelican whose head and pouch make a play button, with a
// curly crest and a feathered nape. Drawn in currentColor so it can sit in
// the accent or in ink; the eye and the line of the bill are cut out, so the
// page shows through. The same shape is the app icon's (build/appicon.svg).
export function PeliMark({ className }: { className?: string }) {
  const mask = `peli-mark-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      aria-hidden
      viewBox="6.5 3 53 53"
      fill="currentColor"
      className={cn("size-6 shrink-0", className)}
    >
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <rect x="22.6" y="13.2" width="4" height="7.4" rx="2" fill="#000" />
        <path
          d="M32.5 24.8C40 27.6 46 30.4 51 32.6"
          fill="none"
          stroke="#000"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path d="M11 24V47Q11 55 18.5 52.4L53 38.6C57.6 36.8 59.6 33.4 57.6 30.4C56.6 28.8 55 28.2 53 27.4L30 14Z" />
        <circle cx="22.5" cy="18.5" r="11.5" />
        <circle cx="11.2" cy="27" r="4.2" />
        <circle cx="11.2" cy="34.5" r="4" />
        <circle cx="11.2" cy="42" r="3.6" />
        <path d="M14 11.5C9 9.5 6.5 12.5 7 16C9 14 11.5 14 13 15.5Z" />
        <path d="M17 8.4C14 4.5 9.6 5.2 8.6 8.4C11.2 7.6 13.6 8.6 14.6 10.6Z" />
      </g>
    </svg>
  );
}

// The name, set in the display serif's italic, with the mark before it.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PeliMark className="size-6 text-sun" />
      <span className="font-display text-[1.6rem] leading-none tracking-[-0.01em] italic">
        Peli
      </span>
    </span>
  );
}
