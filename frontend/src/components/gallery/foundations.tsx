import { Check, X } from "lucide-react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { Materials } from "@/components/gallery/materials";
import { Badge } from "@/components/ui/badge";
import { contrastPairs, contrastRatio } from "@/lib/contrast";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const swatches = [
  ["background", "Page"],
  ["sidebar", "Shell frame"],
  ["card", "Card"],
  ["foreground", "Text"],
  ["muted-foreground", "Muted text"],
  ["primary", "Primary"],
  ["brand", "Brand"],
  ["brand-hover", "Brand hover"],
  ["brand-soft", "Brand tint"],
  ["border", "Hairline"],
  ["destructive", "Destructive"],
  ["success", "Success"],
  ["warning", "Warning"],
] as const;

const typeScale = [
  ["text-display", "Display · hero titles", "font-heading text-display font-stretch-expanded"],
  ["text-title", "Title · page headings", "font-heading text-title font-stretch-semi-expanded"],
  ["text-heading", "Heading · rows", "font-heading text-heading font-stretch-semi-expanded"],
  ["text-base", "Body · synopses, settings", "text-base"],
  ["text-sm", "UI · buttons, nav, card titles", "text-sm font-medium"],
  ["text-meta", "Meta · 2025 · 1h 52m · PG-13", "font-mono text-meta text-muted-foreground"],
] as const;

// A pairing's colour: a token's current value, or a literal hex.
const cssColour = (name: string) => (name.startsWith("#") ? name : `var(--${name})`);

// The token values on screen now. Cheap to read, so read on every render;
// useTheme re-renders when the .dark class changes.
function useTokens(names: readonly string[]): Record<string, string> {
  useTheme();
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
        description="Monochrome surfaces, one lagoon accent. Every value is a CSS variable in index.css, with its own light and dark value."
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
                <code className="text-meta text-muted-foreground">
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
            <thead className="bg-muted text-start text-meta text-muted-foreground">
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
                const ratio = base
                  ? contrastRatio(tokens[pair.foreground] ?? "", base, ...layers)
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
                    <td className="px-4 py-2 text-end font-mono text-meta">{ratio.toFixed(2)}:1</td>
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
        description="Mona Sans, a variable face with a width axis: headings run wide for a marquee feel, UI text stays at normal width. Geist Mono sets metadata."
      >
        <ul className="flex flex-col divide-y">
          {typeScale.map(([token, sample, className]) => (
            <li key={token} className="flex flex-col gap-1 py-4 first:pt-0">
              <code className="text-meta text-muted-foreground">{token}</code>
              <span className={cn("truncate", className)}>{sample}</span>
            </li>
          ))}
        </ul>
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
              <code className="text-meta text-muted-foreground">{label}</code>
            </div>
          ))}
          {(
            [
              ["shadow-card", "shadow-card · at rest"],
              ["shadow-lift", "shadow-lift · hover, hero"],
              ["glass", "glass · popups (Materials, below)"],
            ] as const
          ).map(([shadow, label]) => (
            <div key={label} className="flex flex-col gap-2">
              <div className={cn("h-20 rounded-xl bg-card", shadow)} />
              <code className="text-meta text-muted-foreground">{label}</code>
            </div>
          ))}
          <div className="flex flex-col gap-2">
            <div className="grid h-20 place-items-center rounded-xl border bg-card">
              <div className="size-8 rounded-lg bg-brand transition-[scale,rotate] duration-(--duration-slow) ease-spring motion-safe:hover:scale-125 motion-safe:hover:rotate-12" />
            </div>
            <code className="text-meta text-muted-foreground">ease-spring · --duration-slow</code>
          </div>
        </div>
      </GallerySection>

      <Materials />
    </>
  );
}
