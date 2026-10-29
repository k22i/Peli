import { useEffect, useRef, useState } from "react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { PosterCard } from "@/components/media/cards";
import { PosterGrid } from "@/components/media/poster-grid";
import { Row } from "@/components/media/row";
import { Button } from "@/components/ui/button";

// A 200-poster row and a 1,000-poster grid of distinct generated JPEGs at
// TMDB's w342 size, as the M0 baseline drew them (#7), to check #41's
// targets in the app itself: smooth scrolling, and only the posters near the
// viewport in the DOM (WebKit keeps every <img> in the DOM decoded).
const rowLength = 200;
const gridLength = 1000;

type Stress = { title: string; meta: string; src: string };

function poster(seed: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = 342;
  canvas.height = 513;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve("");
  const hue = (seed * 47) % 360;
  const gradient = context.createLinearGradient(0, 0, 342, 513);
  gradient.addColorStop(0, `hsl(${hue} 60% 35%)`);
  gradient.addColorStop(1, `hsl(${(hue + 90) % 360} 50% 12%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 342, 513);
  for (let index = 0; index < 40; index++) {
    context.fillStyle = `hsl(${(hue + index * 13) % 360} 70% 60% / 0.15)`;
    context.beginPath();
    context.arc(
      (seed * 13 + index * 71) % 342,
      (seed * 7 + index * 53) % 513,
      ((seed * 31 + index * 17) % 97) + 10,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.fillStyle = "#fff";
  context.font = "bold 38px system-ui, sans-serif";
  context.fillText(`#${seed + 1}`, 27, 462);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : ""), "image/jpeg", 0.85);
  });
}

type FrameReport = { frames: number; dropped: number; p95: number; worst: number };

// Scrolls `element` from start to end at a steady speed, one step a frame,
// and counts frames that took longer than a 60 Hz frame.
function scrollTest(element: HTMLElement, axis: "x" | "y", ms: number): Promise<FrameReport> {
  const distance =
    axis === "x"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
  const deltas: number[] = [];
  // Snapping would pull each step back to a card.
  element.style.scrollSnapType = "none";
  return new Promise((resolve) => {
    let start = 0;
    let previous = 0;
    const step = (now: number) => {
      if (!start) [start, previous] = [now, now];
      else deltas.push(now - previous);
      previous = now;
      const offset = Math.min(((now - start) / ms) * distance, distance);
      if (axis === "x") element.scrollLeft = offset;
      else element.scrollTop = offset;
      if (now - start < ms) {
        requestAnimationFrame(step);
        return;
      }
      element.style.scrollSnapType = "";
      const sorted = deltas.toSorted((a, b) => a - b);
      resolve({
        frames: deltas.length,
        dropped: deltas.filter((delta) => delta > 1000 / 60 + 8).length,
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        worst: Math.round(sorted.at(-1) ?? 0),
      });
    };
    requestAnimationFrame(step);
  });
}

export function StressSection() {
  const [items, setItems] = useState<Stress[]>();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState("");
  const section = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      for (const item of items ?? []) URL.revokeObjectURL(item.src);
    },
    [items],
  );

  const load = async () => {
    setLoading(true);
    const sources = await Promise.all(Array.from({ length: rowLength }, (_, seed) => poster(seed)));
    setItems(
      sources.map((src, index) => ({
        title: `Poster ${index + 1}`,
        meta: `${1980 + (index % 45)} · 1h ${30 + (index % 30)}m`,
        src,
      })),
    );
    setLoading(false);
  };

  const run = async () => {
    const root = section.current;
    const row = root?.querySelector<HTMLElement>("[data-slot=row-scroller]");
    const page = document.querySelector<HTMLElement>("#content");
    if (!root || !row) return;
    setReport("Scrolling…");
    root.scrollIntoView({ block: "start" });
    const results = [`row ${JSON.stringify(await scrollTest(row, "x", 6000))}`];
    if (page) results.push(`page ${JSON.stringify(await scrollTest(page, "y", 6000))}`);
    const images = document.querySelectorAll("img").length;
    const line = `${results.join(" ")} images in DOM ${images}`;
    // For scripted runs (#41's profiling): read from the console.
    console.info(`[sinag:scroll-test] ${line}`);
    setReport(line);
  };

  return (
    <GallerySection
      title="Long rows"
      description="200 posters in a row and 1,000 in a grid, with generated art. Only the cards near the viewport are mounted. The scroll test scrolls both end to end and counts frames slower than 60 fps."
      bleed
    >
      <div ref={section} className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3 px-gutter">
          {items ? (
            <Button variant="outline" onClick={() => void run()}>
              Run scroll test
            </Button>
          ) : (
            <Button variant="outline" loading={loading} onClick={() => void load()}>
              Load posters
            </Button>
          )}
          <output aria-live="polite" className="font-mono text-meta text-muted-foreground">
            {report}
          </output>
        </div>
        {items && (
          <>
            <Row
              title={`${rowLength} posters`}
              items={items}
              getKey={(item) => item.title}
              renderItem={(item) => (
                <PosterCard title={item.title} meta={item.meta} src={item.src} />
              )}
            />
            <PosterGrid
              label={`${gridLength} posters`}
              items={Array.from({ length: gridLength }, (_, index) => index)}
              getKey={(index) => index}
              renderItem={(index) => {
                const item = items[index % rowLength]!;
                return <PosterCard title={`Poster ${index + 1}`} meta={item.meta} src={item.src} />;
              }}
            />
          </>
        )}
      </div>
    </GallerySection>
  );
}
