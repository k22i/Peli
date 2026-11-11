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
// modes by contrast.test.ts and listed in the gallery. Translucent layers go
// on top of what they sit over; "over black" and "over white" stand for the
// darkest and brightest art or page under a material.
const media = "#1c1a188c"; // material-media: rgb(28 26 24 / 0.55)

export const contrastPairs: ContrastPair[] = [
  { label: "Text", foreground: "foreground", background: ["background"], min: AA_TEXT },
  {
    label: "Text on a raised surface",
    foreground: "card-foreground",
    background: ["card"],
    min: AA_TEXT,
  },
  { label: "Muted text", foreground: "muted-foreground", background: ["background"], min: AA_TEXT },
  {
    label: "Muted text on a raised surface",
    foreground: "muted-foreground",
    background: ["card"],
    min: AA_TEXT,
  },
  { label: "Popup text", foreground: "popover-foreground", background: ["popover"], min: AA_TEXT },
  {
    label: "Muted popup text",
    foreground: "muted-foreground",
    background: ["popover"],
    min: AA_TEXT,
  },
  // The pop material (menus, selects, tooltips, toasts) over whatever is under it.
  {
    label: "Text on pop, over black",
    foreground: "foreground",
    background: ["#000000", "pop"],
    min: AA_TEXT,
  },
  {
    label: "Text on pop, over white",
    foreground: "foreground",
    background: ["#ffffff", "pop"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on pop, over the page",
    foreground: "muted-foreground",
    background: ["background", "pop"],
    min: AA_TEXT,
  },
  {
    label: "Highlighted menu item",
    foreground: "foreground",
    background: ["background", "pop", "accent"],
    min: AA_TEXT,
  },
  // The top bar and sticky headers once the page scrolls under them.
  {
    label: "Text on the bar, over black",
    foreground: "foreground",
    background: ["#000000", "bar"],
    min: AA_TEXT,
  },
  {
    label: "Text on the bar, over white",
    foreground: "foreground",
    background: ["#ffffff", "bar"],
    min: AA_TEXT,
  },
  // Buttons.
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
  { label: "Sun button", foreground: "sun-foreground", background: ["sun"], min: AA_TEXT },
  // coss's destructive Button sets `text-white`.
  { label: "Destructive button", foreground: "#ffffff", background: ["destructive"], min: AA_TEXT },
  { label: "Selected chip", foreground: "background", background: ["foreground"], min: AA_TEXT },
  // The sun as text: eyebrows, the top pick's label, cached badges.
  { label: "Sun text", foreground: "sun-ink", background: ["background"], min: AA_TEXT },
  {
    label: "Sun text on a raised surface",
    foreground: "sun-ink",
    background: ["card"],
    min: AA_TEXT,
  },
  { label: "Sun badge", foreground: "sun-ink", background: ["card", "sun-soft"], min: AA_TEXT },
  {
    label: "Sun badge on the page",
    foreground: "sun-ink",
    background: ["background", "sun-soft"],
    min: AA_TEXT,
  },
  {
    label: "Badge text on muted",
    foreground: "foreground",
    background: ["card", "muted"],
    min: AA_TEXT,
  },
  // States.
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
  {
    label: "Muted text on a hovered row",
    foreground: "muted-foreground",
    background: ["background", "accent"],
    min: AA_TEXT,
  },
  {
    label: "Settings pane, current",
    foreground: "foreground",
    background: ["background", "accent"],
    min: AA_TEXT,
  },
  // Over artwork and video: always light-on-dark.
  { label: "Hero Play button", foreground: "#141210", background: ["#ffffff"], min: AA_TEXT },
  {
    label: "Icons on media, over white",
    foreground: "#ffffff",
    background: ["#ffffff", media],
    min: AA_UI,
  },
  {
    label: "Text on media, over mid-grey art",
    foreground: "#ffffff",
    background: ["#808080", media],
    min: AA_TEXT,
  },
  {
    label: "Text on media, solid fallback",
    foreground: "#ffffff",
    background: ["#1c1a18"],
    min: AA_TEXT,
  },
  {
    label: "Hero eyebrow, over the scrim",
    foreground: "#ffc46b",
    background: ["#808080", "#000000b3"],
    min: AA_TEXT,
  },
  {
    label: "Player failure text, muted, over the scrim",
    foreground: "#ffffffb3",
    background: ["#ffffff", "#000000bf", media],
    min: AA_TEXT,
  },
  // Focus.
  { label: "Focus ring", foreground: "ring", background: ["background"], min: AA_UI },
  { label: "Focus ring on a raised surface", foreground: "ring", background: ["card"], min: AA_UI },
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
