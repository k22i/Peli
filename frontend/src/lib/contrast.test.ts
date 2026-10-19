import { describe, expect, it } from "vite-plus/test";

import { contrastPairs, contrastRatio } from "@/lib/contrast";
import { indexCss as css } from "@/test/index-css";

// The colour tokens as index.css declares them: the top-level `:root` and
// `.dark` blocks (the ones in @layer base are indented and skipped).
function tokens(selector: ":root" | ".dark"): Record<string, string> {
  const escaped = selector.replace(".", "\\.");
  const block = new RegExp(`^${escaped} \\{([\\s\\S]*?)^\\}`, "m").exec(css)?.[1];
  if (!block) throw new Error(`no ${selector} block in index.css`);
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[\da-f]+);/gi)].map((match) => [match[1], match[2]]),
  );
}

const modes = {
  light: tokens(":root"),
  dark: { ...tokens(":root"), ...tokens(".dark") },
};

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

  it("gives dark mode its own value for every colour", () => {
    const light = tokens(":root");
    const dark = tokens(".dark");
    expect(new Set(Object.keys(dark))).toEqual(new Set(Object.keys(light)));
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
