// Bundles the API (plus the shared workspace package) into one CommonJS file.
// Every package in "dependencies" stays external: GoDaddy installs them from
// the generated manifest. Workspace packages (@kaamsetu/*) are devDependencies
// and therefore get bundled in.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: Object.keys(pkg.dependencies ?? {}),
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
