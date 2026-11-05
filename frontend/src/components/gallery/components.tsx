import { Info, Play, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { GallerySection, Specimen } from "@/components/gallery/gallery-section";
import { StreamSample } from "@/components/gallery/stream-sample";
import { StressSection } from "@/components/gallery/stress";
import { continueWatching, genres, sampleTitles } from "@/components/gallery/samples";
import {
  LandscapeCard,
  LandscapeCardSkeleton,
  PosterCard,
  PosterCardSkeleton,
} from "@/components/media/cards";
import { Chip, ChipGroup, ChipRail } from "@/components/media/chip";
import { Hero, HeroSkeleton } from "@/components/media/hero";
import { Row, RowGroup, RowSkeleton } from "@/components/media/row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";

const [featured] = sampleTitles;

// What a profile with many addons has: 50 catalogs, the 40th selected.
const catalogNames = Array.from({ length: 50 }, (_, index) =>
  index % 5 === 0 ? `Top ${index + 1}` : `Catalog ${index + 1}`,
);

export function Components() {
  const [filters, setFilters] = useState<string[]>(["Drama", "Mystery"]);
  const [catalog, setCatalog] = useState(catalogNames[39]!);
  const [loading, setLoading] = useState(false);

  return (
    <>
      <GallerySection
        title="Hero"
        description="The billboard at the top of Home and detail pages. Always dark over the art; in dark mode it runs edge to edge and melts into the page, in light mode it's an inset card."
        bleed
      >
        <Hero
          title="The Lighthouse Keeper"
          eyebrow="New season"
          meta={[
            <span key="year" className="text-num">
              2024
            </span>,
            <span key="runtime" className="text-num">
              2h 08m
            </span>,
            <span key="rating" className="text-num">
              PG-13
            </span>,
            <Badge key="4k" variant="outline" size="sm">
              4K
            </Badge>,
            <Badge key="hdr" variant="outline" size="sm">
              HDR
            </Badge>,
          ]}
          synopsis="On a storm-cut island at the edge of the map, a keeper who hasn't spoken in years finds a message in the lamp room, written in her own hand."
          actions={
            <>
              <Button size="lg">
                <Play className="fill-current" />
                Play
              </Button>
              <Button size="lg" variant="secondary" className="glass">
                <Info />
                More info
              </Button>
              <Button
                size="icon-lg"
                variant="secondary"
                className="glass"
                aria-label="Add to Library"
              >
                <Plus />
              </Button>
            </>
          }
        />
      </GallerySection>

      <GallerySection
        title="Rows"
        description="Shelves of cards that snap as they scroll. A row is one Tab stop: ←/→, Home and End move between cards, ↑/↓ move to the row above or below, and the paging arrows appear on hover. Only the cards near the viewport are mounted."
        bleed
      >
        <RowGroup>
          <Row
            title="Continue watching"
            action={
              <Button variant="link" size="sm">
                See all
              </Button>
            }
            card="landscape"
            items={continueWatching}
            getKey={(item) => item.title}
            renderItem={(item) => (
              <LandscapeCard
                title={item.title}
                meta={[item.episode, item.runtime].filter(Boolean).join(" · ")}
                progress={item.progress}
              />
            )}
          />
          <Row
            title="Popular movies"
            items={sampleTitles}
            getKey={(item) => item.title}
            renderItem={(item) => (
              <PosterCard
                title={item.title}
                meta={`${item.year} · ${item.runtime}`}
                badge={item.badge && <Badge size="sm">{item.badge}</Badge>}
              />
            )}
          />
        </RowGroup>
      </GallerySection>

      <GallerySection
        title="Cards"
        description="Posters (2:3) and landscape stills (16:9). The art lifts and the focus ring wraps it; with no art, a generated gradient and the title stand in."
      >
        <div className="flex flex-wrap items-start gap-6">
          {featured && (
            <PosterCard
              title={featured.title}
              meta={`${featured.year} · ${featured.runtime}`}
              badge={<Badge size="sm">New</Badge>}
            />
          )}
          <PosterCard title="Paper Moons" meta="2022 · 1h 37m" progress={0.4} />
          <LandscapeCard title="Glass Harbor" meta="S2 · E7 · 12m left" progress={0.84} />
          <LandscapeCard title="Midnight Ferry" meta="2023 · 1h 46m" />
        </div>
      </GallerySection>

      <GallerySection
        title="Buttons"
        description="coss ui's Button on Sinag's tokens. The primary is solid white on black (black on white in light mode), like a Play button should be."
      >
        <Specimen label="variant">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </Specimen>
        <Specimen label="size">
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="xl">Extra large</Button>
          <Button size="icon" variant="outline" aria-label="Add to Library">
            <Plus />
          </Button>
        </Specimen>
        <Specimen label="state">
          <Button
            loading={loading}
            onClick={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 1500);
            }}
          >
            Load sources
          </Button>
          <Button disabled>Disabled</Button>
        </Specimen>
      </GallerySection>

      <GallerySection
        title="Chips and badges"
        description="Chips filter (on: brand tint); badges label. Both come from coss ui."
      >
        <Specimen label="chips · multiple">
          <ChipGroup multiple aria-label="Genres" value={filters} onValueChange={setFilters}>
            {genres.map((genre) => (
              <Chip key={genre} value={genre}>
                {genre}
              </Chip>
            ))}
          </ChipGroup>
        </Specimen>
        <Specimen label="chip rail · 50 catalogs, one line that scrolls sideways">
          <ChipRail
            railClassName="-mx-gutter w-[calc(100%+2*var(--spacing-gutter))]"
            aria-label="Catalogs"
            value={[catalog]}
            onValueChange={(value: string[]) => value[0] && setCatalog(value[0])}
          >
            {catalogNames.map((name) => (
              <Chip key={name} value={name}>
                {name}
              </Chip>
            ))}
          </ChipRail>
        </Specimen>
        <Specimen label="badges">
          <Badge>New</Badge>
          <Badge variant="secondary">Season 2</Badge>
          <Badge variant="outline">4K</Badge>
          <Badge variant="info">Cached</Badge>
          <Badge variant="success">Ready</Badge>
          <Badge variant="warning">Expiring</Badge>
          <Badge variant="error">Unavailable</Badge>
        </Specimen>
      </GallerySection>

      <GallerySection
        title="Overlays"
        description="Dialogs, sheets and toasts sit on frosted glass. Escape closes them and focus returns to what opened them."
      >
        <Specimen label="dialog · sheet · toast">
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>
              <Trash2 />
              Remove from Continue watching
            </DialogTrigger>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Remove “Glass Harbor”?</DialogTitle>
                <DialogDescription>
                  Your progress is kept; the show just leaves Continue watching.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
                <DialogClose render={<Button variant="destructive" />}>Remove</DialogClose>
              </DialogFooter>
            </DialogPopup>
          </Dialog>

          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>
              <SlidersHorizontal />
              Filters
            </SheetTrigger>
            <SheetPopup>
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>Narrow the catalogue by genre.</SheetDescription>
              </SheetHeader>
              <SheetPanel>
                <ChipGroup multiple aria-label="Genres" value={filters} onValueChange={setFilters}>
                  {genres.map((genre) => (
                    <Chip key={genre} value={genre}>
                      {genre}
                    </Chip>
                  ))}
                </ChipGroup>
              </SheetPanel>
              <SheetFooter>
                <Button variant="ghost" onClick={() => setFilters([])}>
                  Clear
                </Button>
              </SheetFooter>
            </SheetPopup>
          </Sheet>

          <Button
            variant="outline"
            onClick={() =>
              toastManager.add({
                type: "success",
                title: "Added to Library",
                description: "The Lighthouse Keeper",
              })
            }
          >
            <Plus />
            Show a toast
          </Button>
        </Specimen>
      </GallerySection>

      <GallerySection
        title="Skeletons"
        description="Loading states with the same shapes as what they stand in for, so nothing shifts when content arrives. The shimmer stops with reduced motion."
        bleed
      >
        <div className="flex flex-col gap-6">
          <HeroSkeleton />
          <RowSkeleton count={6} card="landscape" />
          <div className="flex flex-wrap gap-6 px-gutter">
            <PosterCardSkeleton />
            <LandscapeCardSkeleton />
            <div className="flex w-64 flex-col gap-2">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-5/6 rounded-sm" />
              <Skeleton className="h-4 w-2/3 rounded-sm" />
            </div>
          </div>
        </div>
      </GallerySection>

      <StreamSample />

      <StressSection />
    </>
  );
}
