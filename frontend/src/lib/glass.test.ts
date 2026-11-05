import { describe, expect, it } from "vite-plus/test";

import { indexCss as css } from "@/test/index-css";

const tiers = ["glass-thin", "glass", "glass-thick", "glass-media", "glass-media-strong"];

// The body of `@utility <name> { … }`.
function utility(name: string): string {
  const start = css.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`no @utility ${name} in index.css`);
  const end = css.indexOf("\n}\n", start);
  return css.slice(start, end);
}

// A token's value in the top-level `:root` or `.dark` block.
const value = (selector: string, token: string) =>
  new RegExp(`^${selector} \\{[\\s\\S]*?^  --${token}: (#[\\da-f]+);`, "m").exec(css)?.[1];

describe("glass tiers (index.css)", () => {
  it.each(tiers)("%s is a tint, a blur and a specular edge", (name) => {
    const body = utility(name);
    expect(body).toMatch(
      /background-color: var\(--glass-(thin|regular|thick|media|media-strong)\)/,
    );
    expect(body).toContain("backdrop-filter: blur(");
    // WKWebView builds that still want the prefix.
    expect(body).toContain("-webkit-backdrop-filter: blur(");
    expect(body).toContain("inset 0 1px 0 0");
    expect(body).toContain("inset 0 0 0 0.5px");
  });

  it.each(tiers)("%s falls back to a solid for reduced transparency and more contrast", (name) => {
    const body = utility(name);
    expect(body).toMatch(/@variant reduced-transparency \{[^}]*backdrop-filter: none/);
    expect(body).toMatch(/@variant contrast-more \{[^}]*border: 1px solid/);
  });

  it("treats more contrast like reduced transparency: the variant covers both", () => {
    const start = css.indexOf("@custom-variant reduced-transparency {");
    const body = css.slice(start, css.indexOf("\n}\n", start));
    expect(body).toContain("prefers-reduced-transparency: reduce");
    expect(body).toContain("prefers-contrast: more");
  });

  it("blurs and saturates by tier", () => {
    expect(utility("glass-thin")).toContain("blur(12px) saturate(160%)");
    expect(utility("glass")).toContain("blur(24px) saturate(180%)");
    expect(utility("glass-thick")).toContain("blur(40px) saturate(200%)");
    expect(utility("glass-media")).toContain("blur(30px) saturate(180%)");
  });

  it("makes --popover the regular tint, so bg-popover matches", () => {
    expect(value(":root", "popover")).toBe(value(":root", "glass-regular"));
    expect(value("\\.dark", "popover")).toBe(value("\\.dark", "glass-regular"));
  });

  it("puts coss's popups on tiers: dialogs and sheets thick, the rest regular", () => {
    expect(css).toMatch(
      /\[data-slot="dialog-popup"\],\s*\[data-slot="sheet-popup"\] \{\s*@apply glass-thick;/,
    );
    expect(css).toMatch(
      /\[data-slot="menu-popup"\],\s*\[data-slot="tooltip-popup"\],\s*\[data-slot="toast-popup"\] \{\s*@apply glass;/,
    );
  });
});
