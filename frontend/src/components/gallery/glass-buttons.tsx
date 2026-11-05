import { Info, Play, Plus, Check } from "lucide-react";

import { GallerySection, Specimen } from "@/components/gallery/gallery-section";
import { busy } from "@/components/gallery/materials";
import { glassButton, pillButton } from "@/components/account/focus-screen";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The same pill the hero's buttons use (routes/index.tsx `heroButton`).
const heroPill =
  "rounded-full px-6 transition-transform duration-(--duration-fast) motion-safe:active:scale-[0.97]";

// Apple TV's pattern for actions over artwork: the main one solid, the rest
// glass. Over art (the hero, the title page) that is `glass-media`, which stays
// dark in both themes; on the page (the sign-in and profile screens) it is
// the regular `glass` tier through `glassButton`.
export function GlassButtons() {
  return (
    <GallerySection
      title="Glass buttons"
      description="Play is solid white; everything else beside it is glass. Over artwork the buttons are media glass (always dark, white text). On the page they are the regular tier. The tint stays on hover and a faint wash marks it, and the pills press in to 0.97."
    >
      <Specimen label="over artwork · glass-media">
        <div
          className="dark flex min-h-48 w-full flex-wrap items-end gap-3 overflow-hidden rounded-3xl p-6"
          style={busy}
        >
          <Button size="lg" className={cn(heroPill, "bg-white text-black hover:bg-white/90")}>
            <Play className="fill-current" />
            Play
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={cn(
              heroPill,
              "glass-media-strong text-white hover:text-white hover:before:bg-white/15",
            )}
          >
            <Info />
            Details
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Add to Library"
            className="size-11 rounded-full text-white glass-media hover:bg-(--glass-media) hover:text-white hover:before:bg-white/15 sm:size-11"
          >
            <Plus />
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            aria-label="Mark as watched"
            className="size-11 rounded-full text-white glass-media hover:bg-(--glass-media) hover:text-white hover:before:bg-white/15 sm:size-11"
          >
            <Check />
          </Button>
        </div>
      </Specimen>
      <Specimen label="on the page · glass">
        <div className="flex w-full flex-wrap items-center gap-3 rounded-3xl border bg-background p-6">
          <Button className={pillButton}>Continue</Button>
          <Button variant="ghost" className={cn(pillButton, glassButton)}>
            Use a code instead
          </Button>
          <Button variant="ghost" className={cn(pillButton, glassButton)}>
            Not now
          </Button>
        </div>
      </Specimen>
    </GallerySection>
  );
}
