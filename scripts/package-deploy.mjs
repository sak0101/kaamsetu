#!/usr/bin/env node
// Assembles the GoDaddy deployment directory (dist-deploy/) and ZIP from the
// monorepo build output, then validates the ZIP. Run via `npm run package`
// (which builds first) or `npm run stage` (no ZIP).
//
// ZIP root layout (no enclosing folder):
//   package.json  package-lock.json  server.js  check-build.js  public/

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-deploy");
const zipPath = path.join(root, "kaamsetu-deploy.zip");
const noZip = process.argv.includes("--no-zip");

const GODADDY_LIMIT_BYTES = 100 * 1024 * 1024;
const OUR_BUDGET_BYTES = 50 * 1024 * 1024; // stricter than GoDaddy's limit on purpose

const ALLOWED_TOP_LEVEL = new Set([
  "package.json",
  "package-lock.json",
  "server.js",
  "check-build.js",
  "public",
]);

const CHECK_BUILD_JS = `// Runs as "npm run build" on GoDaddy. The frontend and server are compiled
// before packaging, so this verifies the artefacts instead of rebuilding them.
const fs = require("node:fs");
const path = require("node:path");
const required = ["server.js", path.join("public", "index.html")];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) {
  console.error("Build check failed. Missing: " + missing.join(", "));
  process.exit(1);
}
console.log("Build check passed: " + required.join(", ") + " present.");
`;

const fail = (msg) => {
  console.error(`\nPACKAGE FAILED: ${msg}`);
  process.exit(1);
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------- 1. Inputs must exist ----------
const serverBundle = path.join(root, "apps/api/dist/server.js");
const webDist = path.join(root, "apps/web/dist");
if (!fs.existsSync(serverBundle)) fail("apps/api/dist/server.js missing. Run `npm run build` first.");
if (!fs.existsSync(path.join(webDist, "index.html"))) fail("apps/web/dist/index.html missing. Run `npm run build` first.");

// ---------- 2. Assemble dist-deploy/ ----------
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(serverBundle, path.join(outDir, "server.js"));
fs.cpSync(webDist, path.join(outDir, "public"), { recursive: true });
fs.writeFileSync(path.join(outDir, "check-build.js"), CHECK_BUILD_JS);

// ---------- 3. Generate the deployment manifest ----------
const apiPkg = readJson(path.join(root, "apps/api/package.json"));
const dependencies = apiPkg.dependencies ?? {};
const workspaceLeaks = Object.keys(dependencies).filter((d) => d.startsWith("@kaamsetu/"));
if (workspaceLeaks.length) {
  fail(`Workspace packages must be devDependencies of apps/api (they are bundled): ${workspaceLeaks.join(", ")}`);
}

const manifest = {
  name: "kaamsetu",
  version: apiPkg.version,
  description: "KaamSetu: hyperlocal marketplace for short-term manual work.",
  private: true,
  main: "server.js",
  scripts: {
    build: "node check-build.js",
    start: "node server.js",
  },
  engines: { node: ">=22" },
  dependencies,
};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

// ---------- 4. Generate package-lock.json for that manifest ----------
console.log("Generating package-lock.json ...");
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: outDir,
  stdio: "inherit",
  shell: process.platform === "win32", // npm is npm.cmd on Windows; args are fixed literals
});

if (noZip) {
  console.log(`\nStaged ${path.relative(root, outDir)}/ (no ZIP requested).`);
  process.exit(0);
}

// ---------- 5. Create the ZIP (forward-slash entry paths, files at root) ----------
fs.rmSync(zipPath, { force: true });
const zip = new AdmZip();
for (const name of ["package.json", "package-lock.json", "server.js", "check-build.js"]) {
  zip.addLocalFile(path.join(outDir, name));
}
zip.addLocalFolder(path.join(outDir, "public"), "public");
zip.writeZip(zipPath);

// ---------- 6. Validate the ZIP as written to disk ----------
const problems = [];
const check = new AdmZip(zipPath);
const entries = check.getEntries();
const names = entries.map((e) => e.entryName);

for (const required of ["package.json", "package-lock.json", "server.js", "check-build.js", "public/index.html"]) {
  if (!names.includes(required)) problems.push(`missing at ZIP root: ${required}`);
}

for (const name of names) {
  const top = name.split("/")[0];
  if (!ALLOWED_TOP_LEVEL.has(top)) problems.push(`unexpected top-level entry: ${name}`);
  if (name.includes("\\")) problems.push(`backslash in entry path: ${name}`);
  const segments = name.split("/");
  if (segments.includes("node_modules") || segments.includes(".git")) problems.push(`forbidden directory: ${name}`);
  const base = segments[segments.length - 1];
  if (/^\.env/i.test(base)) problems.push(`env file in ZIP: ${name}`);
  if (/\.(pem|key|p12|map)$/i.test(base)) problems.push(`forbidden file type: ${name}`);
}

const zipSize = fs.statSync(zipPath).size;
if (zipSize > OUR_BUDGET_BYTES) problems.push(`ZIP is ${zipSize} bytes, over our ${OUR_BUDGET_BYTES} budget`);
if (zipSize > GODADDY_LIMIT_BYTES) problems.push(`ZIP exceeds GoDaddy's 100 MB limit`);

// Manifest as stored in the ZIP
const storedManifest = JSON.parse(check.readAsText("package.json"));
for (const field of ["name", "version", "main"]) {
  if (!storedManifest[field]) problems.push(`manifest field "${field}" is empty`);
}
if (storedManifest.main !== "server.js" || !names.includes(storedManifest.main)) problems.push("manifest main does not point at a file in the ZIP");
if (!storedManifest.scripts?.build || !storedManifest.scripts?.start) problems.push("manifest needs build and start scripts");
if (storedManifest.devDependencies) problems.push("manifest must not contain devDependencies");

// Secret-shaped strings in text entries
const secretPatterns = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, "JWT-shaped token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];
for (const e of entries) {
  if (e.isDirectory || !/\.(js|json|html|css|txt|svg)$/i.test(e.entryName)) continue;
  const text = e.getData().toString("utf8");
  for (const [re, label] of secretPatterns) {
    if (re.test(text)) problems.push(`${label} pattern found in ${e.entryName}`);
  }
}

console.log(`\nZIP: ${path.relative(root, zipPath)} (${(zipSize / 1024).toFixed(1)} KiB, ${entries.filter((e) => !e.isDirectory).length} files)`);
for (const n of names.filter((n) => !n.endsWith("/"))) console.log(`  ${n}`);

if (problems.length) {
  console.error("\nValidation problems:");
  for (const p of problems) console.error(`  - ${p}`);
  fail("ZIP validation failed.");
}
console.log("\nZIP validation passed.");
