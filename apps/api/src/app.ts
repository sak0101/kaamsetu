import fs from "node:fs";
import path from "node:path";
import express from "express";
import { APP_NAME } from "@kaamsetu/shared";

export interface AppOptions {
  /** Directory holding the compiled SPA (index.html + assets). Optional in dev. */
  staticDir?: string;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: APP_NAME });
  });

  // Unknown API routes must be JSON 404s, never the SPA shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

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
