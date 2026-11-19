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

export interface SupabaseConfig {
  url: string;
  /** Anon/publishable key. Used for JWT verification and user-scoped reads. */
  anonKey: string;
  /** SECRET. Used only by the privileged RPC client. Never logged, never sent to the browser. */
  serviceRoleKey: string;
}

/**
 * Read Supabase settings from the environment. Missing values are a startup
 * error (we never guess). Error messages name variables, never values.
 */
export function loadSupabaseConfig(env: NodeJS.ProcessEnv): SupabaseConfig {
  const names = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }

  const url = env.SUPABASE_URL!.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SUPABASE_URL must be an http(s) URL.");
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use https in production.");
  }

  return {
    url: url.replace(/\/+$/, ""),
    anonKey: env.SUPABASE_ANON_KEY!.trim(),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  };
}

export interface AiConfig {
  /** SECRET. Server-side only; never sent to the browser. */
  apiKey: string;
  model: string;
  /** Test/staging override (e.g. a local stub of the Messages API). Unset in production. */
  baseURL?: string;
}

/** Default model for job drafting (configurable with ANTHROPIC_MODEL). */
export const DEFAULT_AI_MODEL = "claude-opus-5-5";

/**
 * AI job drafting is optional: without ANTHROPIC_API_KEY the AI endpoints answer
 * 503 `ai_not_configured` and the rest of the app works. Returns null when unset.
 * (Claude Code's own login is NOT a runtime key: the application needs its own key.)
 */
export function loadAiConfig(env: NodeJS.ProcessEnv): AiConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const baseURL = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  if (baseURL && env.NODE_ENV === "production") {
    throw new Error("ANTHROPIC_BASE_URL must not be set in production.");
  }
  return { apiKey, model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_AI_MODEL, baseURL };
}

export interface MailConfig {
  host: string;
  port: number;
  /** The authenticated mailbox. Also used as the From address. */
  user: string;
  /** SECRET. Server-side only; never logged or sent to the browser. */
  pass: string;
  /** Where contact-form messages are delivered. */
  to: string;
}

/** Default recipient for contact-form messages (a public address, not a secret). */
export const DEFAULT_CONTACT_TO = "info@kaamsetu.tech";

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * The contact form is optional: without SMTP settings POST /api/contact answers 503
 * `contact_not_configured` and the page falls back to showing the email address.
 * Returns null when any of SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS is unset.
 * Error messages name variables, never values.
 */
export function loadMailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const rawPort = env.SMTP_PORT?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  if (!host || !rawPort || !user || !pass) return null;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }
  if (!EMAIL_RE.test(user)) {
    throw new Error("SMTP_USER must be the full mailbox address (it is used as the From address).");
  }
  const to = env.CONTACT_TO?.trim() || DEFAULT_CONTACT_TO;
  if (!EMAIL_RE.test(to)) throw new Error("CONTACT_TO is not a valid email address.");
  return { host, port, user, pass, to };
}
