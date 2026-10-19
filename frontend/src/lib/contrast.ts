// WCAG 2.2 contrast for the theme's hex tokens (#rgb, #rrggbb, #rrggbbaa).
// Used by the contrast test and the gallery's swatches.

export type Rgba = { r: number; g: number; b: number; a: number };

// The AA minimums: body text, and UI parts such as the focus ring (1.4.11).
export const AA_TEXT = 4.5;
export const AA_UI = 3;

export type ContrastPair = {
  label: string;
  // Token names without the leading `--`, or a literal hex colour where a
  // component hard-codes one. Backgrounds go back to front.
  foreground: string;
  background: [string, ...string[]];
  min: number;
};

// Every foreground/background pairing the components use, checked in both
// modes by contrast.test.ts and listed in the gallery.
export const contrastPairs: ContrastPair[] = [
  { label: "Text", foreground: "foreground", background: ["background"], min: AA_TEXT },
  { label: "Text on card", foreground: "card-foreground", background: ["card"], min: AA_TEXT },
  { label: "Text on sidebar", foreground: "foreground", background: ["sidebar"], min: AA_TEXT },
  {
    label: "Muted text",
    foreground: "muted-foreground",
    background: ["background"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on card",
    foreground: "muted-foreground",
    background: ["card"],
    min: AA_TEXT,
  },
  {
    label: "Sidebar item",
    foreground: "sidebar-foreground",
    background: ["sidebar"],
    min: AA_TEXT,
  },
  {
    label: "Sidebar item, active",
    foreground: "sidebar-accent-foreground",
    background: ["sidebar", "sidebar-accent"],
    min: AA_TEXT,
  },
  {
    label: "Primary button",
    foreground: "primary-foreground",
    background: ["primary"],
    min: AA_TEXT,
  },
  {
    label: "Secondary button",
    foreground: "secondary-foreground",
    background: ["background", "secondary"],
    min: AA_TEXT,
  },
  {
    // coss's destructive Button sets `text-white`.
    label: "Destructive button",
    foreground: "#ffffff",
    background: ["destructive"],
    min: AA_TEXT,
  },
  {
    label: "Brand fill",
    foreground: "brand-foreground",
    background: ["brand"],
    min: AA_TEXT,
  },
  { label: "Brand text", foreground: "brand", background: ["background"], min: AA_TEXT },
  {
    label: "Selected chip",
    foreground: "brand",
    background: ["background", "brand-soft"],
    min: AA_TEXT,
  },
  {
    label: "Popup text",
    foreground: "popover-foreground",
    background: ["background", "popover"],
    min: AA_TEXT,
  },
  {
    label: "Popup muted text",
    foreground: "muted-foreground",
    background: ["background", "popover"],
    min: AA_TEXT,
  },
  {
    label: "Error text",
    foreground: "destructive-foreground",
    background: ["background"],
    min: AA_TEXT,
  },
  {
    label: "Success text",
    foreground: "success-foreground",
    background: ["background"],
    min: AA_TEXT,
  },
  {
    label: "Warning text",
    foreground: "warning-foreground",
    background: ["background"],
    min: AA_TEXT,
  },
  { label: "Info text", foreground: "info-foreground", background: ["background"], min: AA_TEXT },
  { label: "Focus ring", foreground: "ring", background: ["background"], min: AA_UI },
  { label: "Focus ring on sidebar", foreground: "ring", background: ["sidebar"], min: AA_UI },
  { label: "Focus ring on card", foreground: "ring", background: ["card"], min: AA_UI },
];

export function parseHex(hex: string): Rgba {
  let digits = hex.trim().replace(/^#/, "");
  if (digits.length === 3 || digits.length === 4) {
    digits = digits.replace(/./g, "$&$&");
  }
  if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(digits)) throw new Error(`not a hex colour: ${hex}`);
  const channel = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: digits.length === 8 ? channel(6) / 255 : 1,
  };
}

// Paints a translucent colour over an opaque one.
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (front: number, back: number) => front * top.a + back * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// `foreground` on `background`, each a hex colour; translucent layers are
// listed back to front after the first (opaque) background.
export function contrastRatio(foreground: string, ...backgrounds: [string, ...string[]]): number {
  const [base, ...layers] = backgrounds.map(parseHex);
  const surface = layers.reduce((under, layer) => composite(layer, under), base!);
  const text = composite(parseHex(foreground), surface);
  const [a, b] = [luminance(text), luminance(surface)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
