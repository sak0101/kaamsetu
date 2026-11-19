import fs from "node:fs";
import path from "node:path";
import express from "express";
import { APP_NAME } from "@kaamsetu/shared";
import { createContactRouter } from "./contact";
import { errorHandler } from "./errors";
import type { ContactMailer } from "./mailer";
import { createApiRouter } from "./routes";
import type { Deps } from "./types";

export interface AppOptions {
  /** Directory holding the compiled SPA (index.html + assets). Optional in dev. */
  staticDir?: string;
  /** Supabase-backed dependencies. When omitted only /api/health is served (hello-world mode / tests). */
  deps?: Deps;
  /** Browser-safe Supabase settings (URL + anon key ONLY), served at runtime so nothing is baked into the build. */
  publicConfig?: { supabaseUrl: string; supabaseAnonKey: string };
  /** SMTP-backed contact form sender. Null/omitted: POST /api/contact answers 503 contact_not_configured. */
  mailer?: ContactMailer | null;
  /** Demo mode for the contact form: validates, answers `{ ok, demo: true }`, sends nothing. Off unless explicitly enabled. */
  contactDemo?: boolean;
  /** Reverse-proxy hops to trust for req.ip (per-client rate limits). Leave unset unless verified. */
  trustProxy?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy) app.set("trust proxy", options.trustProxy);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: APP_NAME });
  });

  const publicConfig = options.publicConfig;
  if (publicConfig) {
    app.get("/api/public-config", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      // Explicit field pick: only these two public values can ever be sent.
      res.json({ supabaseUrl: publicConfig.supabaseUrl, supabaseAnonKey: publicConfig.supabaseAnonKey });
    });
  }

  // Public and independent of Supabase, so it works even when the data API is not configured.
  app.use("/api/contact", createContactRouter(options.mailer ?? null, { demo: options.contactDemo === true }));

  if (options.deps) {
    app.use("/api", createApiRouter(options.deps));
  }

  // Unknown API routes must be JSON 404s, never the SPA shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
  });

  // Consistent JSON errors for everything under /api.
  app.use("/api", errorHandler);

  const staticDir = options.staticDir;
  const indexHtml = staticDir ? path.join(staticDir, "index.html") : undefined;

  if (staticDir && indexHtml && fs.existsSync(indexHtml)) {
    // Vite emits content-hashed files under /assets, so they can be cached hard.
    app.use(
      "/assets",
      express.static(path.join(staticDir, "assets"), { immutable: true, maxAge: "1y" }),
    );
    app.use(express.static(staticDir));

    // SPA fallback so client-side routes survive a refresh or a shared link.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.sendFile(indexHtml);
    });
  }

  return app;
}
