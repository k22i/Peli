import { Check, Info, Play, Plus } from "lucide-react";

import { GallerySection, Specimen } from "@/components/gallery/gallery-section";
import { busy } from "@/components/gallery/materials";
import { glassButton, pillButton } from "@/components/account/focus-screen";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Actions over artwork: Play in solid white, the rest on the media material,
// which stays dark in both themes. On the page (the sign-in and profile
// screens) the main action is sun or ink and the rest are soft ink tints.
export function GlassButtons() {
  return (
    <GallerySection
      title="Buttons over art"
      description="Play is solid white; everything beside it over art is the media material (always dark, white text). On the page the quieter actions are secondary capsules."
    >
      <Specimen label="over artwork · light and media">
        <div
          className="dark flex min-h-48 w-full flex-wrap items-end gap-2.5 overflow-hidden rounded-3xl p-6"
          style={busy}
        >
          <Button size="xl" variant="light">
            <Play className="fill-current" />
            Play
          </Button>
          <Button size="xl" variant="media">
            <Info />
            Details
          </Button>
          <Button size="icon-xl" variant="media" aria-label="Add to Library">
            <Plus />
          </Button>
          <Button size="icon-xl" variant="media" aria-label="Mark as watched">
            <Check />
          </Button>
        </div>
      </Specimen>
      <Specimen label="on the page · sun and ink tints">
        <div className="flex w-full flex-wrap items-center gap-3 rounded-3xl border bg-background p-6">
          <Button variant="sun" className={pillButton}>
            Continue
          </Button>
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
