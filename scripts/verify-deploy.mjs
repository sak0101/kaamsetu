#!/usr/bin/env node
// Simulates GoDaddy locally: unzips kaamsetu-deploy.zip into a fresh temp
// directory OUTSIDE the repo, then runs `npm install`, `npm run build`,
// `npm start` (with PORT set) and probes the running app.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipPath = path.join(root, "kaamsetu-deploy.zip");
const isWin = process.platform === "win32";
const results = [];

const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

if (!fs.existsSync(zipPath)) {
  console.error("kaamsetu-deploy.zip not found. Run `npm run package` first.");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaamsetu-verify-"));
console.log(`Extracting into ${tmp}\n`);
new AdmZip(zipPath).extractAllTo(tmp, true);

const npm = (args) =>
  execFileSync("npm", args, { cwd: tmp, stdio: "pipe", shell: isWin, encoding: "utf8" });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

const killTree = (child) => {
  if (!child.pid) return;
  if (isWin) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
};

let child;
try {
  // Root contents exactly as GoDaddy would see them
  const rootFiles = fs.readdirSync(tmp).sort();
  record("ZIP root contains package.json, package-lock.json, server.js, public/",
    ["package.json", "package-lock.json", "server.js", "public"].every((f) => rootFiles.includes(f)),
    rootFiles.join(", "));

  npm(["install", "--no-audit", "--no-fund"]);
  record("npm install", true);

  const buildOut = npm(["run", "build"]);
  record("npm run build", /Build check passed/.test(buildOut));

  const installed = fs.readdirSync(path.join(tmp, "node_modules")).filter((d) => !d.startsWith("."));
  record("no dev tooling installed (vite/typescript/esbuild absent)",
    !["vite", "typescript", "esbuild", "react"].some((d) => installed.includes(d)),
    `${installed.length} packages`);

  // Dummy, non-functional placeholders: enough for the server to boot and serve
  // /api/health. They point at a reserved .invalid host and are never real credentials.
  const PLACEHOLDER_SUPABASE = {
    SUPABASE_URL: "https://placeholder.invalid",
    SUPABASE_ANON_KEY: "placeholder-anon",
    SUPABASE_SERVICE_ROLE_KEY: "placeholder-service",
  };
  // Never inherit real Supabase settings from the developer's shell.
  const cleanEnv = { ...process.env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" };

  // Production start without PORT must fail loudly
  const noPort = spawn("node", ["server.js"], {
    cwd: tmp,
    env: { ...cleanEnv, ...PLACEHOLDER_SUPABASE, NODE_ENV: "production", PORT: "" },
    stdio: "pipe",
  });
  const noPortCode = await new Promise((resolve) => noPort.on("exit", resolve));
  record("production start without PORT exits non-zero", noPortCode !== 0, `exit ${noPortCode}`);

  // Production start without Supabase settings must fail loudly (never guess)
  const noSb = spawn("node", ["server.js"], {
    cwd: tmp,
    env: { ...cleanEnv, NODE_ENV: "production", PORT: String(await freePort()) },
    stdio: "pipe",
  });
  const noSbCode = await new Promise((resolve) => noSb.on("exit", resolve));
  record("production start without Supabase settings exits non-zero", noSbCode !== 0, `exit ${noSbCode}`);

  // Real start via `npm start` on a random port
  const port = await freePort();
  child = spawn("npm", ["start"], {
    cwd: tmp,
    env: { ...cleanEnv, ...PLACEHOLDER_SUPABASE, NODE_ENV: "production", PORT: String(port) },
    stdio: "pipe",
    shell: isWin,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  record(`npm start binds process.env.PORT (${port})`, up && log.includes(`port ${port}`), log.trim().split("\n").pop());

  if (up) {
    const health = await (await fetch(`${base}/api/health`)).json();
    record("GET /api/health returns { ok: true }", health.ok === true);

    const home = await fetch(`${base}/`);
    const html = await home.text();
    record("GET / serves compiled React shell", home.status === 200 && html.includes('id="root"'));

    const deep = await fetch(`${base}/worker/jobs/123`);
    record("deep link falls back to index.html", deep.status === 200 && (await deep.text()).includes('id="root"'));

    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const assetRes = asset ? await fetch(`${base}${asset}`) : undefined;
    record("hashed JS asset served", assetRes?.status === 200, asset);

    const missing = await fetch(`${base}/api/does-not-exist`);
    record("unknown /api route is JSON 404", missing.status === 404 && /json/.test(missing.headers.get("content-type") ?? ""));
  }
} catch (err) {
  record("verification run", false, String(err.stderr ?? err.message ?? err).slice(0, 400));
} finally {
  if (child) killTree(child);
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
