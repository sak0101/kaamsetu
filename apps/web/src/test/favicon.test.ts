import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// QA found /favicon.ico returning 404 (a console error on every page load).
describe("favicon", () => {
  it("index.html links an icon that exists in public/", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const href = /<link[^>]*rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    expect(href, "index.html must declare <link rel=icon>").toBeTruthy();
    expect(fs.existsSync(path.join(root, "public", href!.replace(/^\//, ""))), `${href} missing from public/`).toBe(true);
  });
});
