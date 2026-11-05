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
  { label: "Brand text on card", foreground: "brand", background: ["card"], min: AA_TEXT },
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
  // Glass (#111). The tint paints over whatever is behind, so the text is
  // measured over the worst backdrops: pure black and pure white. Regular and
  // thick hold text over either in both modes. Thin is for chips and icons
  // over content, and a light-on-glass pair over bright artwork fails by
  // design, so it is measured over the page and cards it sits on.
  {
    label: "Text on regular glass, over black",
    foreground: "foreground",
    background: ["#000000", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Text on regular glass, over white",
    foreground: "foreground",
    background: ["#ffffff", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Text on thick glass, over black",
    foreground: "foreground",
    background: ["#000000", "glass-thick"],
    min: AA_TEXT,
  },
  {
    label: "Text on thick glass, over white",
    foreground: "foreground",
    background: ["#ffffff", "glass-thick"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on regular glass",
    foreground: "muted-foreground",
    background: ["background", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on thick glass",
    foreground: "muted-foreground",
    background: ["background", "glass-thick"],
    min: AA_TEXT,
  },
  {
    label: "Text on thin glass, over the page",
    foreground: "foreground",
    background: ["background", "glass-thin"],
    min: AA_TEXT,
  },
  {
    label: "Text on thin glass, over a card",
    foreground: "foreground",
    background: ["card", "glass-thin"],
    min: AA_TEXT,
  },
  {
    // Always dark, so white on the strong tint over a white frame (4.7:1).
    label: "Text on media glass, over white",
    foreground: "#ffffff",
    background: ["#ffffff", "glass-media-strong"],
    min: AA_TEXT,
  },
  {
    // Icons only (3.4:1 over a white frame); text uses the strong tint.
    label: "Icons on media glass, over white",
    foreground: "#ffffff",
    background: ["#ffffff", "glass-media"],
    min: AA_UI,
  },
  {
    // Home's hero Play button (#115): black on solid white.
    label: "Hero Play button",
    foreground: "#000000",
    background: ["#ffffff"],
    min: AA_TEXT,
  },
  {
    label: "Text on media glass, solid fallback",
    foreground: "#ffffff",
    background: ["#ffffff", "#000000e0"],
    min: AA_TEXT,
  },
  // The player (#121): its text sits on strong media glass over whatever the
  // video shows, so plain white is what holds over a white frame; muted white
  // (white/70) doesn't (3.2:1) and isn't used there. The shortcut keys sit on
  // a darker chip, and the failure card over the scrim, where muted text is
  // fine.
  {
    label: "Player shortcut key, over white",
    foreground: "#ffffff",
    background: ["#ffffff", "#0000008c", "#0000004d"],
    min: AA_TEXT,
  },
  {
    label: "Player failure text, muted, over the scrim",
    foreground: "#ffffffb3",
    background: ["#ffffff", "#000000bf", "#0000008c"],
    min: AA_TEXT,
  },
  // The sidebar's active item (#114): brand-soft over the thick glass, over
  // the worst backdrops. The icon is brand (3:1), the label foreground.
  {
    label: "Sidebar active icon, over black",
    foreground: "brand",
    background: ["#000000", "glass-thick", "brand-soft"],
    min: AA_UI,
  },
  {
    label: "Sidebar active icon, over white",
    foreground: "brand",
    background: ["#ffffff", "glass-thick", "brand-soft"],
    min: AA_UI,
  },
  {
    label: "Sidebar active label, over black",
    foreground: "foreground",
    background: ["#000000", "glass-thick", "brand-soft"],
    min: AA_TEXT,
  },
  {
    label: "Sidebar active label, over white",
    foreground: "foreground",
    background: ["#ffffff", "glass-thick", "brand-soft"],
    min: AA_TEXT,
  },
  {
    label: "Text on glass, solid fallback",
    foreground: "foreground",
    background: ["glass-solid"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on glass, solid fallback",
    foreground: "muted-foreground",
    background: ["glass-solid"],
    min: AA_TEXT,
  },
  // The stream picker and the shared popups (#122). Glass over the page, as
  // for the other regular-glass text pairs.
  {
    label: "Badge text on muted, over a card",
    foreground: "foreground",
    background: ["card", "muted"],
    min: AA_TEXT,
  },
  {
    label: "Badge text on muted, on regular glass",
    foreground: "foreground",
    background: ["background", "glass-regular", "muted"],
    min: AA_TEXT,
  },
  {
    label: "Cached badge, over a card",
    foreground: "brand",
    background: ["card", "brand-soft"],
    min: AA_TEXT,
  },
  {
    label: "Cached badge, on regular glass",
    foreground: "brand",
    background: ["background", "glass-regular", "brand-soft"],
    min: AA_TEXT,
  },
  {
    label: "Top pick label, on regular glass",
    foreground: "brand",
    background: ["background", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Highlighted menu item, on regular glass",
    foreground: "foreground",
    background: ["background", "glass-regular", "accent"],
    min: AA_TEXT,
  },
  // The title page (#117): the information card's labels on thin glass over
  // the page, and an episode's synopsis on the row's hover fill (accent, at
  // full strength, which is stronger than the row's accent/60).
  {
    label: "Muted text on thin glass, over the page",
    foreground: "muted-foreground",
    background: ["background", "glass-thin"],
    min: AA_TEXT,
  },
  {
    label: "Muted text on a hovered episode row",
    foreground: "muted-foreground",
    background: ["background", "accent"],
    min: AA_TEXT,
  },
  { label: "Focus ring", foreground: "ring", background: ["background"], min: AA_UI },
  { label: "Focus ring on sidebar", foreground: "ring", background: ["sidebar"], min: AA_UI },
  { label: "Focus ring on card", foreground: "ring", background: ["card"], min: AA_UI },
  // Settings' pane list (#120): the current pane's label over its brand-soft
  // pill, and its icon (brand-foreground on the brand tile is "Brand fill").
  {
    label: "Settings pane label, current",
    foreground: "foreground",
    background: ["background", "brand-soft"],
    min: AA_TEXT,
  },
  // The PIN keypad (#123): digits on thin glass keys, inside the thick glass
  // of a dialog or the lock card, over black or white.
  {
    label: "PIN key digit, over black",
    foreground: "foreground",
    background: ["#000000", "glass-thick", "glass-thin"],
    min: AA_TEXT,
  },
  {
    label: "PIN key digit, over white",
    foreground: "foreground",
    background: ["#ffffff", "glass-thick", "glass-thin"],
    min: AA_TEXT,
  },
  // Library (#118): the view switch's idle tab (muted text on thin glass, on
  // the page or inside the stuck header's regular glass), and the Upcoming
  // day header's label on regular glass, also over the worst backdrops.
  {
    label: "Library view switch, idle tab",
    foreground: "muted-foreground",
    background: ["background", "glass-thin"],
    min: AA_TEXT,
  },
  {
    label: "Library view switch, idle tab, in the stuck header",
    foreground: "muted-foreground",
    background: ["background", "glass-regular", "glass-thin"],
    min: AA_TEXT,
  },
  {
    label: "Day header label, over the page",
    foreground: "foreground",
    background: ["background", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Day header label, over black",
    foreground: "foreground",
    background: ["#000000", "glass-regular"],
    min: AA_TEXT,
  },
  {
    label: "Day header label, over white",
    foreground: "foreground",
    background: ["#ffffff", "glass-regular"],
    min: AA_TEXT,
  },
  // Search's field (#119): the clear button's icon on thin glass over the
  // field's regular glass, and the ⌘F hint on its muted chip.
  {
    label: "Search clear button",
    foreground: "foreground",
    background: ["background", "glass-regular", "glass-thin"],
    min: AA_UI,
  },
  {
    label: "Shortcut hint",
    foreground: "muted-foreground",
    background: ["muted"],
    min: AA_TEXT,
  },
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
