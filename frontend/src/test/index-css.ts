/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// index.css as written. Vitest stubs CSS imports (even `?raw`), so read it
// from disk; tests run from the frontend directory.
export const indexCss = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
