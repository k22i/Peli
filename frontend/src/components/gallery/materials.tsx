import { useState, type CSSProperties } from "react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { Ambient } from "@/components/media/ambient";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// The glass tiers (#111, ADR-0046). `utility` is the class a component uses.
const tiers = [
  {
    utility: "glass-thin",
    use: "Chips, small controls over content, row arrows",
    values: "12px blur · 160% saturate",
    dark: false,
  },
  {
    utility: "glass",
    use: "Popovers, menus, tooltips, toasts, sticky headers",
    values: "24px blur · 180% saturate",
    dark: false,
  },
  {
    utility: "glass-thick",
    use: "Sidebar, sheets, dialogs, settings nav",
    values: "40px blur · 200% saturate",
    dark: false,
  },
  {
    utility: "glass-media",
    use: "Icons over artwork and video",
    values: "30px blur · 180% saturate · tint 45%",
    dark: true,
  },
  {
    utility: "glass-media-strong",
    use: "Text over artwork and video",
    values: "30px blur · 180% saturate · tint 55%",
    dark: true,
  },
] as const;

// The art tone's sample: an inline SVG poster, so the gallery needs no
// network and ships no third-party image.
const ambientArt = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#13324a"/><circle cx="90" cy="80" r="90" fill="#e9573f"/><circle cx="300" cy="120" r="110" fill="#33b5e0"/><circle cx="220" cy="260" r="80" fill="#f5c542"/></svg>`,
)}`;

// A busy backdrop, so the blur and the tint have something to work on:
// stripes, blobs and hard-edged shapes, with no third-party images.
const busy: CSSProperties = {
  backgroundImage: [
    "radial-gradient(40% 60% at 15% 25%, oklch(0.78 0.17 25), transparent 70%)",
    "radial-gradient(45% 55% at 80% 20%, oklch(0.8 0.15 200), transparent 70%)",
    "radial-gradient(50% 60% at 60% 90%, oklch(0.7 0.2 300), transparent 70%)",
    "repeating-linear-gradient(115deg, oklch(0.95 0.02 90) 0 14px, oklch(0.25 0.05 260) 14px 28px)",
  ].join(", "),
};

function Tiles({ className }: { className?: string }) {
  return (
    <ul className={cn("grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4 p-5", className)}>
      {tiers.map((tier) => (
        <li
          key={tier.utility}
          className={cn(
            "flex min-h-28 flex-col gap-1 rounded-2xl p-4",
            tier.utility,
            tier.dark ? "text-white" : "text-popover-foreground",
          )}
        >
          <code className="font-mono text-sm font-medium">{tier.utility}</code>
          <span className="text-sm">{tier.use}</span>
          <span className="font-mono text-meta opacity-80">{tier.values}</span>
        </li>
      ))}
    </ul>
  );
}

// Content scrolls under a sticky header; the strip below it softens what
// passes (the `scroll-edge-top` utility).
function ScrollEdge() {
  return (
    <div className="h-64 overflow-y-auto rounded-2xl border bg-background">
      <div className="scroll-edge-top sticky top-0 z-10 bg-background/90 px-5 py-3">
        <h3 className="font-heading text-heading">Page header</h3>
        <p className="text-sm text-muted-foreground">
          Scroll the list: it passes under the header and softens at its edge.
        </p>
      </div>
      <ol className="flex flex-col gap-2 px-5 pb-5">
        {Array.from({ length: 24 }, (_, index) => (
          <li
            key={index}
            className="flex items-center gap-3 rounded-lg bg-secondary px-3 py-2 text-sm"
          >
            <span className="size-8 shrink-0 rounded-md bg-brand/70" />
            Episode {index + 1}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Materials() {
  // Mirrors the OS setting for the section only: the fallback rules answer to
  // `data-transparency="reduced"` as well as prefers-reduced-transparency.
  const [reduced, setReduced] = useState(false);

  return (
    <GallerySection
      title="Materials"
      description="Four glass tiers, defined once in index.css. Pick a tier; never hand-roll backdrop-blur, and never stack a light tier on another light tier. Each is a tint, a blur, a soft highlight from the top and a specular edge. Switch themes above to see both."
    >
      <div data-transparency={reduced ? "reduced" : undefined} className="flex flex-col gap-6">
        <div className="flex w-fit items-center gap-3 text-sm">
          <Switch
            aria-label="Reduced transparency"
            checked={reduced}
            onCheckedChange={setReduced}
          />
          Reduced transparency
          <span className="text-muted-foreground">
            · every tier turns solid; the OS setting and Increase contrast do the same
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-meta text-muted-foreground">Over artwork</h3>
          <div className="overflow-hidden rounded-3xl" style={busy}>
            <Tiles />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-meta text-muted-foreground">Over the page</h3>
          <div className="rounded-3xl border bg-background">
            <Tiles />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-meta text-muted-foreground">
            Ambient · brand tone and art tone
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["brand", "art"] as const).map((tone) => (
              <div
                key={tone}
                className="relative isolate h-56 overflow-hidden rounded-2xl border bg-background p-5"
              >
                <Ambient tone={tone} src={tone === "art" ? ambientArt : undefined} />
                <code className="font-mono text-sm">{`tone="${tone}"`}</code>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                  {tone === "brand"
                    ? "Two pools of the lagoon accent, behind a page's content."
                    : "The page's artwork, blurred to a haze of its colours."}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-meta text-muted-foreground">Scroll edge</h3>
          <ScrollEdge />
        </div>
      </div>
    </GallerySection>
  );
}
