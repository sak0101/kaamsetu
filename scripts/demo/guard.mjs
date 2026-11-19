// Safety guard for the demo-data script. Pure functions: no network access.
//
// The script writes demo accounts and jobs, so it must only ever point at the ONE project it was written for.
// The project reference is the first label of the hosted URL (https://<ref>.supabase.co).

export const DEMO_PROJECT_REF = "praqzylbpqanqexhputi";

/** The project reference of a hosted Supabase URL, or null for anything else (local stack, other hosts, junk). */
export function projectRefFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Throws unless SUPABASE_URL points at exactly DEMO_PROJECT_REF. A local URL, a different project, a look-alike host
 * and a missing URL are all refused. There is deliberately no override.
 */
export function assertDemoTarget(url) {
  const ref = projectRefFromUrl(url ?? "");
  if (ref !== DEMO_PROJECT_REF) {
    throw new Error(
      `Refusing to run: SUPABASE_URL must be https://${DEMO_PROJECT_REF}.supabase.co (this script writes demo data and only ever targets that project).`,
    );
  }
  return ref;
}

/** Passwords come from the environment only. They must be long enough and are never printed. */
export function readPasswords(env) {
  const employer = env.DEMO_PASSWORD_EMPLOYER?.trim();
  const worker = env.DEMO_PASSWORD_WORKER?.trim();
  const missing = [["DEMO_PASSWORD_EMPLOYER", employer], ["DEMO_PASSWORD_WORKER", worker]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}.`);
  const short = [["DEMO_PASSWORD_EMPLOYER", employer], ["DEMO_PASSWORD_WORKER", worker]].filter(([, v]) => v.length < 12).map(([k]) => k);
  if (short.length) throw new Error(`${short.join(" and ")} must be at least 12 characters.`);
  return { employer, worker };
}

/** The run must be asked for explicitly: --confirm=<project ref>. Nothing runs by accident or from another script. */
export function assertConfirmed(argv) {
  const flag = argv.find((a) => a.startsWith("--confirm="));
  if (flag?.slice("--confirm=".length) !== DEMO_PROJECT_REF) {
    throw new Error(`Add --confirm=${DEMO_PROJECT_REF} to run this against the hosted project. (Use --dry-run to see what would happen without connecting.)`);
  }
}
