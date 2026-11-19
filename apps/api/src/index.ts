import path from "node:path";
import { createApp } from "./app";
import { createAiService } from "./ai";
import { loadAiConfig, loadMailConfig, loadSupabaseConfig, resolvePort } from "./config";
import { createContactMailer, type ContactMailer } from "./mailer";
import { createSupabaseDeps } from "./supabase";
import type { Deps } from "./types";

let port: number;
try {
  port = resolvePort(process.env);
} catch (err) {
  console.error(`[kaamsetu] Startup failed: ${(err as Error).message}`);
  process.exit(1);
}

// Supabase settings are mandatory in production (never guess). In development a
// missing configuration only disables the data API so the UI shell still runs.
let deps: Deps | undefined;
let publicConfig: { supabaseUrl: string; supabaseAnonKey: string } | undefined;
try {
  const supabaseConfig = loadSupabaseConfig(process.env);
  const aiConfig = loadAiConfig(process.env);
  deps = { ...createSupabaseDeps(supabaseConfig), ai: aiConfig ? createAiService(aiConfig) : null };
  console.log(aiConfig ? `[kaamsetu] AI job drafting enabled (model: ${aiConfig.model})` : "[kaamsetu] AI job drafting disabled: set ANTHROPIC_API_KEY to enable it");
  // Browser-safe values only (URL + anon key). The service-role key never leaves supabase.ts.
  publicConfig = { supabaseUrl: supabaseConfig.url, supabaseAnonKey: supabaseConfig.anonKey };
} catch (err) {
  if (process.env.NODE_ENV === "production") {
    console.error(`[kaamsetu] Startup failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.warn(`[kaamsetu] Data API disabled: ${(err as Error).message}`);
}

// The contact form is optional and independent of Supabase. Settings are read once; values are never logged.
let mailer: ContactMailer | null = null;
try {
  const mailConfig = loadMailConfig(process.env);
  mailer = mailConfig ? createContactMailer(mailConfig) : null;
  console.log(mailer ? "[kaamsetu] Contact form enabled" : "[kaamsetu] Contact form disabled: set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS to enable it");
} catch (err) {
  console.warn(`[kaamsetu] Contact form disabled: ${(err as Error).message}`);
}
const trustProxy = Number(process.env.TRUST_PROXY_HOPS) || undefined;

// In the production bundle, server.js sits next to public/. In dev (tsx) this
// directory does not exist and static serving is skipped; Vite serves the SPA.
const app = createApp({ staticDir: path.resolve(__dirname, "public"), deps, publicConfig, mailer, trustProxy });

// GoDaddy Node.js Hosting requires an explicit IPv4 wildcard bind on process.env.PORT.
const HOST = "0.0.0.0";
const server = app.listen(port, HOST, () => {
  console.log(`[kaamsetu] Listening on ${HOST}, port ${port} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
});

server.on("error", (err) => {
  console.error(`[kaamsetu] Server error: ${err.message}`);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
