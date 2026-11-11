import { describe, expect, it } from "vite-plus/test";

import { indexCss as css } from "@/test/index-css";

const materials = ["material-bar", "material-pop", "material-media"];

// The body of `@utility <name> { … }`.
function utility(name: string): string {
  const start = css.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`no @utility ${name} in index.css`);
  const end = css.indexOf("\n}\n", start);
  return css.slice(start, end);
}

describe("materials (index.css)", () => {
  it.each(materials)("%s is a tint and a blur", (name) => {
    const body = utility(name);
    expect(body).toMatch(/background-color: /);
    expect(body).toContain("backdrop-filter: blur(");
    // WKWebView builds that still want the prefix.
    expect(body).toContain("-webkit-backdrop-filter: blur(");
  });

  it.each(materials)("%s turns solid for reduced transparency and more contrast", (name) => {
    expect(utility(name)).toMatch(/@variant reduced-transparency \{[^}]*backdrop-filter: none/);
  });

  it("treats more contrast like reduced transparency: the variant covers both", () => {
    const start = css.indexOf("@custom-variant reduced-transparency {");
    const body = css.slice(start, css.indexOf("\n}\n", start));
    expect(body).toContain("prefers-reduced-transparency: reduce");
    expect(body).toContain("prefers-contrast: more");
  });

  it("puts coss's menus, selects, tooltips and toasts on the pop material", () => {
    expect(css).toMatch(
      /\[data-slot="menu-popup"\],\s*\[data-slot="select-popup"\],\s*\[data-slot="tooltip-popup"\],\s*\[data-slot="toast-popup"\] \{\s*@apply material-pop;/,
    );
  });

  it("gives dialogs and sheets the solid popup surface", () => {
    expect(css).toMatch(
      /\[data-slot="dialog-popup"\],\s*\[data-slot="sheet-popup"\] \{\s*background-color: var\(--popover\);/,
    );
  });
});
