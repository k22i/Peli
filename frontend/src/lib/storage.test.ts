/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Webview storage is a plain file in the app-data directory, so it must never
// hold tokens (#15). The only thing kept there is the theme, which has to be
// read before first paint; everything else goes through the Go store, and
// secrets through the keychain (lib/secrets.ts).
const allowed = new Set(["lib/theme.ts"]);
const webStorage = /\b(localStorage|sessionStorage|indexedDB)\s*[.[]/;
const comments = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

const src = join(process.cwd(), "src");
const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
  .map((file) => file.replaceAll("\\", "/"))
  .filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("test/"),
  );

describe("web storage", () => {
  it("is used only for the theme", () => {
    expect(sources.length).toBeGreaterThan(10);
    const users = sources.filter((file) =>
      webStorage.test(readFileSync(join(src, file), "utf8").replace(comments, "")),
    );
    expect(users).toContain("lib/theme.ts");
    expect(users.filter((file) => !allowed.has(file))).toEqual([]);
  });
});
