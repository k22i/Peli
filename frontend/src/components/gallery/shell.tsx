import { Search } from "lucide-react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { SunMark } from "@/components/shell/wordmark";

// The hero's stand-in: a warm sky over a dark horizon, as a backdrop is.
const art = [
  "radial-gradient(60% 90% at 70% 10%, oklch(0.75 0.14 60), transparent 70%)",
  "radial-gradient(55% 80% at 20% 40%, oklch(0.45 0.1 30), transparent 70%)",
  "linear-gradient(180deg, oklch(0.3 0.04 50), oklch(0.14 0.02 50))",
].join(", ");

// The app shell in miniature: the top bar, clear over the hero's art, with
// the wordmark, the sections and the profile; the hero pulls up under it and
// melts into the canvas, and the shelves follow.
function MiniWindow() {
  return (
    <div
      aria-hidden
      className="relative h-80 overflow-hidden rounded-3xl bg-background hairline [--fade:var(--background)]"
    >
      <div
        className="dark relative flex h-48 flex-col justify-end gap-1 px-5 pb-6 text-white"
        style={{ backgroundImage: art }}
      >
        <div className="absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-(--fade) to-transparent" />
        <code className="relative text-small opacity-80">under-bar</code>
        <span className="relative font-display text-3xl leading-none">Art under the bar</span>
      </div>
      <ul className="flex gap-3 px-5 py-3">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="h-24 w-16 shrink-0 rounded-lg bg-secondary" />
        ))}
      </ul>

      <div className="absolute inset-x-0 top-0 flex h-9 items-center gap-3 px-3 text-white">
        <span className="flex gap-1.5">
          {["#ff5f57", "#febc2e", "#28c840"].map((colour) => (
            <span key={colour} className="size-2.5 rounded-full" style={{ background: colour }} />
          ))}
        </span>
        <span className="flex items-center gap-1">
          <SunMark className="size-3.5 text-[#ffb547]" />
          <span className="font-display text-sm italic">Sinag</span>
        </span>
        <span className="mx-auto flex items-center gap-3 rounded-full bg-black/30 px-3 py-1 text-[0.625rem] font-semibold">
          <span className="relative">
            Home
            <span className="absolute -bottom-1 left-1/2 size-0.5 -translate-x-1/2 rounded-full bg-[#ffb547]" />
          </span>
          <span className="opacity-60">Movies</span>
          <span className="opacity-60">Shows</span>
          <span className="opacity-60">Library</span>
          <Search className="size-2.5 opacity-60" />
        </span>
        <span className="size-4 rounded-full bg-white/70" />
      </div>
    </div>
  );
}

export function Shell() {
  return (
    <GallerySection
      title="Shell"
      description="A top bar over a content pane that fills the window. The bar holds the wordmark, the sections (a small sun marks the current one) and the profile; over a hero it is clear with light text, and it frosts once the page scrolls. Pages start below it; a full-bleed hero pulls itself up under it with under-bar."
    >
      <MiniWindow />
    </GallerySection>
  );
}
