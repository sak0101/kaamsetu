/**
 * Resolve the TCP port from the environment.
 *
 * GoDaddy Node.js Hosting supplies PORT. In production a missing or invalid
 * PORT is a startup error: we never silently guess. The 3001 fallback exists
 * only for local development.
 */
export function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();

  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("PORT environment variable is required in production.");
    }
    return 3001;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${raw}").`);
  }
  return port;
}
