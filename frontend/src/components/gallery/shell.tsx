import { House, Library, Search } from "lucide-react";

import { GallerySection } from "@/components/gallery/gallery-section";

// The hero's stand-in: shapes in the brand and a warm colour, dark at the
// edges as a poster's backdrop is.
const art = [
  "radial-gradient(60% 90% at 20% 20%, oklch(0.62 0.17 30), transparent 70%)",
  "radial-gradient(55% 80% at 80% 30%, oklch(0.7 0.13 215), transparent 70%)",
  "linear-gradient(180deg, oklch(0.25 0.04 260), oklch(0.15 0.02 260))",
].join(", ");

// The app shell in miniature (#114): a floating glass sidebar and a title
// strip over a pane that pads itself by --sidebar-inset and --titlebar-h. The
// first block uses `bleed`, so its art runs under both; its text offsets
// itself by the inset plus the gutter. Everything below it keeps clear.
function MiniWindow() {
  return (
    <div
      aria-hidden
      className="relative h-80 overflow-hidden rounded-3xl border bg-background [--sidebar-inset:8rem] [--titlebar-h:1.75rem]"
    >
      <div className="size-full overflow-hidden ps-(--sidebar-inset) pt-(--titlebar-h)">
        <div
          className="bleed flex h-44 flex-col justify-end gap-1 pb-4 ps-[calc(var(--sidebar-inset)+1.25rem)] text-white"
          style={{ backgroundImage: art }}
        >
          <code className="font-mono text-meta opacity-80">bleed</code>
          <span className="text-heading">Art under the glass</span>
        </div>
        <ul className="flex gap-3 py-4 pe-5 ps-5">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="h-24 w-16 shrink-0 rounded-lg bg-secondary" />
          ))}
        </ul>
      </div>

      <div className="absolute inset-x-0 top-0 flex h-(--titlebar-h) items-center gap-1.5 ps-3">
        {["#ff5f57", "#febc2e", "#28c840"].map((colour) => (
          <span key={colour} className="size-2.5 rounded-full" style={{ background: colour }} />
        ))}
      </div>

      <div className="absolute start-2 top-2 bottom-2 flex w-28 flex-col gap-1 rounded-2xl p-2 pt-7 glass-thick">
        <div className="flex h-6 items-center gap-1.5 rounded-lg px-2 text-meta text-muted-foreground glass-thin">
          <Search className="size-3" />
          Search
        </div>
        <div className="mt-1 flex h-7 items-center gap-1.5 rounded-lg bg-brand-soft px-2 text-meta font-medium">
          <House className="size-3.5 text-brand" />
          Home
        </div>
        <div className="mt-3 flex h-7 items-center gap-1.5 rounded-lg px-2 text-meta text-sidebar-foreground">
          <Library className="size-3.5" />
          Library
        </div>
      </div>
    </div>
  );
}

export function Shell() {
  return (
    <GallerySection
      title="Shell"
      description="The content pane fills the window and scrolls under a floating glass sidebar and the title bar. It pads itself by --sidebar-inset and --titlebar-h, so pages need nothing. Full-bleed artwork uses the bleed utility to run under both; text on it offsets itself by the inset plus the gutter."
    >
      <MiniWindow />
    </GallerySection>
  );
}
