import { cn } from "@/lib/utils";

// Sinag's mark: a low sun, half risen, throwing five rays. Drawn in
// currentColor so it can sit in the accent or in ink.
export function SunMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 32 32"
      fill="none"
      className={cn("size-6 shrink-0", className)}
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
    >
      <path d="M7 22a9 9 0 0 1 18 0" />
      <path d="M3 26.5h26" />
      <path d="M16 4.5v4" />
      <path d="M6.2 9.2l2.8 2.8" />
      <path d="M25.8 9.2l-2.8 2.8" />
      <path d="M1.8 17.5h3.4" />
      <path d="M26.8 17.5h3.4" />
    </svg>
  );
}

// The name, set in the display serif's italic, with the mark before it.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SunMark className="size-5.5 text-sun" />
      <span className="font-display text-[1.6rem] leading-none tracking-[-0.01em] italic">
        Sinag
      </span>
    </span>
  );
}
