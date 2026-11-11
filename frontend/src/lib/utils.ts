import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Peli's type tokens (index.css, #112) are font sizes. Without this, tailwind-merge
// reads `type-title` as a colour and drops it next to `text-white`, or the other way
// round. `tnum` is the mono utility: it sets a family, no size or colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["display", "title", "heading", "body", "item", "caption", "meta", "label"] },
    classGroups: { "font-family": [{ text: ["num"] }] },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
