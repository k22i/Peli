import { describe, expect, it } from "vite-plus/test";

import { contrastPairs, contrastRatio } from "@/lib/contrast";
import { indexCss as css } from "@/test/index-css";

// The colour tokens as index.css declares them: the top-level `:root` block
// (the ones in @layer base are indented and skipped). Peli is dark only
// (#143), so these are the one set.
function tokens(): Record<string, string> {
  const block = /^:root \{([\s\S]*?)^\}/m.exec(css)?.[1];
  if (!block) throw new Error("no :root block in index.css");
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[\da-f]+);/gi)].map((match) => [match[1], match[2]]),
  );
}

const modes = { dark: tokens() };

describe("theme contrast", () => {
  describe.each(Object.entries(modes))("%s mode", (_, values) => {
    const colour = (name: string) => {
      if (name.startsWith("#")) return name;
      const value = values[name];
      if (!value) throw new Error(`--${name} is not a hex token`);
      return value;
    };

    it.each(contrastPairs)("$label meets WCAG AA", ({ foreground, background, min }) => {
      const [base, ...layers] = background.map(colour);
      expect(contrastRatio(colour(foreground), base!, ...layers)).toBeGreaterThanOrEqual(min);
    });
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("composites translucent layers", () => {
    // 50% white over black is #808080.
    expect(contrastRatio("#000000", "#000000", "#ffffff80")).toBeCloseTo(
      contrastRatio("#000000", "#808080"),
      1,
    );
  });
});
