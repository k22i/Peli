import type { ComponentProps } from "react";

// A caption-size badge (#122): `h-6 rounded-md px-2`, neutral on `bg-muted`.
// The brand tone is for "Cached" alone: it is the one badge that says a
// stream plays at once. HDR, Dolby Vision and the rest stay neutral.
//
// A plain element, not coss's Badge: that merges classes with tailwind-merge,
// which reads the `text-meta` size token as a colour and drops one of them.
export function StreamBadge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "brand" }) {
  const look = tone === "brand" ? "bg-brand-soft text-brand" : "bg-muted text-foreground";
  return (
    <span
      data-slot="stream-badge"
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-meta font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0 ${look} ${className ?? ""}`}
      {...props}
    />
  );
}
