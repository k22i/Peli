import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { tabIconName } from "@/lib/tab-icons";
import { sections } from "@/sections";

// build/ios/Assets.xcassets, from frontend/.
const catalog = join(process.cwd(), "..", "build", "ios", "Assets.xcassets");
const update = process.env["UPDATE_TAB_ICONS"] === "1";

// The SVG UIKit draws: the lucide glyph in black (a template image takes its
// colour from the tint), 24 pt, the web's stroke width.
function svgOf(section: (typeof sections)[number]): string {
  const markup = renderToStaticMarkup(
    createElement(section.icon, { size: 24, color: "#000000", strokeWidth: 2, "aria-hidden": true }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}\n`;
}

function contentsOf(file: string): string {
  return `${JSON.stringify(
    {
      images: [{ filename: file, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" },
    },
    null,
    2,
  )}\n`;
}

describe("native tab bar icons", () => {
  it.each(sections.map((section) => [section.label, section] as const))(
    "%s has a template SVG in the asset catalog",
    (_, section) => {
      const name = tabIconName(section);
      const dir = join(catalog, `${name}.imageset`);
      const file = `${name}.svg`;
      if (update) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), svgOf(section));
        writeFileSync(join(dir, "Contents.json"), contentsOf(file));
      }
      expect(existsSync(join(dir, file)), `${dir}/${file} (UPDATE_TAB_ICONS=1 writes it)`).toBe(true);
      // The same glyph as the web, so a lucide upgrade or a new icon shows.
      expect(readFileSync(join(dir, file), "utf8")).toBe(svgOf(section));
      expect(JSON.parse(readFileSync(join(dir, "Contents.json"), "utf8"))).toEqual(
        JSON.parse(contentsOf(file)),
      );
    },
  );
});
