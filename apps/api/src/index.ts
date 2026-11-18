import path from "node:path";
import { createApp } from "./app";
import { createAiService } from "./ai";
import { loadAiConfig, loadSupabaseConfig, resolvePort } from "./config";
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

// In the production bundle, server.js sits next to public/. In dev (tsx) this
// directory does not exist and static serving is skipped; Vite serves the SPA.
const app = createApp({ staticDir: path.resolve(__dirname, "public"), deps, publicConfig });

const server = app.listen(port, () => {
  console.log(`[kaamsetu] Listening on port ${port} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
});

server.on("error", (err) => {
  console.error(`[kaamsetu] Server error: ${err.message}`);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
