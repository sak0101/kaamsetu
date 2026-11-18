// Runs the API integration tests against the LOCAL Supabase stack only.
//   npm run test:integration -w @kaamsetu/api      (needs `supabase start`)
// Keys are read from `supabase status` and passed to the test process through
// its environment; they are never printed or written to disk.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const apiDir = path.join(repoRoot, "apps/api");
const DB_CONTAINER = "supabase_db_kaamsetu";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function localEnv() {
  const out = execFileSync(npx, ["supabase", "status", "-o", "env"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
  const vars = Object.fromEntries(
    out
      .split(/\r?\n/)
      .map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  for (const k of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
    if (!vars[k]) throw new Error(`supabase status did not return ${k}. Is the local stack running? (supabase start)`);
  }
  // Safety: this runner must never point at a hosted project.
  const host = new URL(vars.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Refusing to run integration tests against a non-local API URL.");
  }
  return { SUPABASE_URL: vars.API_URL, SUPABASE_ANON_KEY: vars.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: vars.SERVICE_ROLE_KEY };
}

function cleanup() {
  const sql = `
    delete from public.notifications where user_id in (select id from auth.users where email like '%@api-it.invalid');
    delete from public.bookings where employer_id in (select id from auth.users where email like '%@api-it.invalid');
    delete from public.job_applications where job_id in (select id from public.jobs where employer_id in (select id from auth.users where email like '%@api-it.invalid'));
    delete from public.jobs where employer_id in (select id from auth.users where email like '%@api-it.invalid');
    delete from auth.users where email like '%@api-it.invalid';`;
  execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-q"], { input: sql, stdio: ["pipe", "ignore", "inherit"] });
}

let status = 1;
try {
  const env = { ...process.env, ...localEnv(), NODE_ENV: "test" };
  cleanup();
  const r = spawnSync(npx, ["vitest", "run", "--config", "vitest.integration.config.ts"], {
    cwd: apiDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  status = r.status ?? 1;
} catch (err) {
  console.error(`Integration run failed: ${err.message}`);
} finally {
  try {
    cleanup();
  } catch {
    /* best effort */
  }
}
process.exit(status);
