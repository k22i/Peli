import type { ComponentProps } from "react";

// A caption-size badge (#122): `h-6 rounded-md px-2`, neutral on `bg-muted`.
// The brand tone is for "Cached" alone: it is the one badge that says a
// stream plays at once. HDR, Dolby Vision and the rest stay neutral.
//
// A plain element, not coss's Badge: that merges classes with tailwind-merge,
// which reads the `text-small` size token as a colour and drops one of them.
export function StreamBadge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "sun" }) {
  const look = tone === "sun" ? "bg-sun-soft text-sun-ink" : "bg-muted text-foreground";
  return (
    <span
      data-slot="stream-badge"
      className={`inline-flex h-5.5 shrink-0 items-center gap-1 rounded-full px-2.5 text-tiny font-[620] tracking-[0.01em] whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0 ${look} ${className ?? ""}`}
      {...props}
    />
  );
}
