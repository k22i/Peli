import { Check, X } from "lucide-react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { Materials } from "@/components/gallery/materials";
import { Shell } from "@/components/gallery/shell";
import { TypeSample } from "@/components/gallery/type-sample";
import { Badge } from "@/components/ui/badge";
import { contrastPairs, contrastRatio } from "@/lib/contrast";
import { cn } from "@/lib/utils";

const swatches = [
  ["background", "Canvas"],
  ["card", "Raised"],
  ["popover", "Popup"],
  ["foreground", "Ink"],
  ["muted-foreground", "Muted ink"],
  ["faint", "Faint ink"],
  ["primary", "Primary"],
  ["sun", "Sun"],
  ["sun-ink", "Sun as text"],
  ["sun-soft", "Sun tint"],
  ["border", "Hairline"],
  ["destructive", "Destructive"],
  ["success", "Success"],
  ["warning", "Warning"],
] as const;

// The scale. Each class is the real utility from index.css.
const typeScale = [
  ["type-hero", "Hero · marquee titles", "Instrument Serif · 400 · clamp 3–6.25rem · 0.92"],
  ["type-display", "Display · page titles", "Instrument Serif · 400 · clamp 2.5–3.75rem"],
  ["type-title", "Title · pane headings", "System · 650 · −0.018em · 1.375rem"],
  ["type-row", "Row · shelf headings", "System · 650 · −0.014em · 1.1875rem"],
  ["text-body", "Body · synopses, settings, UI", "System · 14px · line-height 1.5"],
  ["type-item", "Item · card captions", "System · 14px · 560"],
  ["text-small", "Small · meta lines", "System · 13px · line-height 1.4"],
  ["type-eyebrow", "Eyebrow · Continue watching", "System · 11px · 650 · +0.14em · uppercase"],
  ["tnum", "2025 · 1h 52m · S2 · E5 · 1:12:08", "Tabular figures, so numbers line up"],
] as const;

// A pairing's colour: a token's current value, or a literal hex.
const cssColour = (name: string) => (name.startsWith("#") ? name : `var(--${name})`);

// The token values on screen now. Cheap to read, so read on every render.
function useTokens(names: readonly string[]): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    names.map((name) => [
      name,
      name.startsWith("#") ? name : style.getPropertyValue(`--${name}`).trim(),
    ]),
  );
}

const tokenNames = [
  ...new Set([
    ...swatches.map(([name]) => name),
    ...contrastPairs.flatMap((pair) => [pair.foreground, ...pair.background]),
  ]),
];

export function Foundations() {
  const tokens = useTokens(tokenNames);

  return (
    <>
      <GallerySection
        title="Colour"
        description="A warm screening room in dark mode and warm paper in light, and one accent: the sun, kept for progress, the current place and focus. Every value is a CSS variable in index.css, with its own light and dark value."
      >
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {swatches.map(([name, label]) => (
            <li key={name} className="flex flex-col gap-2">
              <div
                className="h-16 rounded-xl shadow-card ring-1 ring-border ring-inset"
                style={{ background: `var(--${name})` }}
              />
              <div className="flex flex-col px-0.5">
                <span className="text-sm font-medium">{label}</span>
                <code className="text-small text-muted-foreground">
                  --{name} {tokens[name]}
                </code>
              </div>
            </li>
          ))}
        </ul>
      </GallerySection>

      <GallerySection
        title="Contrast"
        description="Every pairing the components use, measured live. WCAG AA: 4.5:1 for text, 3:1 for the focus ring. contrast.test.ts checks the same pairs in both modes."
      >
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-start text-small text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Pairing</th>
                <th className="px-4 py-2 text-start font-medium">Sample</th>
                <th className="px-4 py-2 text-end font-medium">Ratio</th>
                <th className="px-4 py-2 text-end font-medium">AA</th>
              </tr>
            </thead>
            <tbody>
              {contrastPairs.map((pair) => {
                const [base, ...layers] = pair.background.map((name) => tokens[name] ?? "");
                const foreground = tokens[pair.foreground] ?? "";
                // Until the stylesheet has loaded, a token reads as empty.
                const ratio =
                  base && foreground && layers.every(Boolean)
                    ? contrastRatio(foreground, base, ...layers)
                    : 0;
                const passes = ratio >= pair.min;
                return (
                  <tr key={pair.label} className="border-t">
                    <td className="px-4 py-2">{pair.label}</td>
                    <td className="px-4 py-2">
                      <span
                        className="inline-grid h-7 min-w-16 place-items-center rounded-md px-2 font-medium"
                        style={{
                          color: cssColour(pair.foreground),
                          background: pair.background
                            .toReversed()
                            .map(
                              (name) => `linear-gradient(${cssColour(name)}, ${cssColour(name)})`,
                            )
                            .join(", "),
                        }}
                      >
                        Aa
                      </span>
                    </td>
                    <td className="px-4 py-2 text-end tnum text-small">{ratio.toFixed(2)}:1</td>
                    <td className="px-4 py-2 text-end">
                      <Badge variant={passes ? "success" : "error"}>
                        {passes ? <Check aria-hidden /> : <X aria-hidden />}
                        {passes ? "Pass" : "Fail"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GallerySection>

      <GallerySection
        title="Type"
        description="The system face carries the interface; Instrument Serif, a narrow display serif, is kept for a few large moments only: hero, page and section titles, dialog titles and the wordmark. Body is 14px."
      >
        <ul className="flex flex-col divide-y">
          {typeScale.map(([token, sample, spec]) => (
            <li key={token} className="flex flex-col gap-1 py-4 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <code className="text-small text-muted-foreground">{token}</code>
                <span className="text-small text-muted-foreground">{spec}</span>
              </div>
              <span className={cn("truncate", token === "type-eyebrow" && "text-sun-ink", token)}>
                {sample}
              </span>
            </li>
          ))}
        </ul>
      </GallerySection>

      <GallerySection
        title="Type in use"
        description="The scale on a hero, a row with two captioned posters, a title page, a settings row and a player time readout. Mono is only the numbers: years, runtimes, S2 · E5, times."
      >
        <TypeSample />
      </GallerySection>

      <GallerySection
        title="Shape, depth and motion"
        description="Generous, continuous-feeling radii; soft, deep shadows; a spring that settles with a slight overshoot. Hover the tiles. With reduced motion on, nothing moves."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4">
          {(
            [
              ["rounded-md", "rounded-md"],
              ["rounded-xl", "rounded-xl · cards"],
              ["rounded-2xl", "rounded-2xl · dialogs"],
              ["rounded-full", "rounded-full · chips"],
            ] as const
          ).map(([radius, label]) => (
            <div key={radius} className="flex flex-col gap-2">
              <div className={cn("h-20 border bg-card", radius)} />
              <code className="text-small text-muted-foreground">{label}</code>
            </div>
          ))}
          {(
            [
              ["shadow-card", "shadow-card · at rest"],
              ["shadow-float", "shadow-float · hover, hero"],
              ["material-pop", "material-pop · popups (Materials, below)"],
            ] as const
          ).map(([shadow, label]) => (
            <div key={label} className="flex flex-col gap-2">
              <div className={cn("h-20 rounded-xl bg-card", shadow)} />
              <code className="text-small text-muted-foreground">{label}</code>
            </div>
          ))}
          <div className="flex flex-col gap-2">
            <div className="grid h-20 place-items-center rounded-xl border bg-card">
              <div className="size-8 rounded-lg bg-sun transition-[scale,rotate] duration-(--duration-slow) ease-bounce motion-safe:hover:scale-125 motion-safe:hover:rotate-12" />
            </div>
            <code className="text-small text-muted-foreground">ease-bounce · --duration-slow</code>
          </div>
        </div>
      </GallerySection>

      <Materials />
      <Shell />
    </>
  );
}
