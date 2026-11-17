import path from "node:path";
import { createApp } from "./app";
import { resolvePort } from "./config";

let port: number;
try {
  port = resolvePort(process.env);
} catch (err) {
  console.error(`[kaamsetu] Startup failed: ${(err as Error).message}`);
  process.exit(1);
}

// In the production bundle, server.js sits next to public/. In dev (tsx) this
// directory does not exist and static serving is skipped; Vite serves the SPA.
const app = createApp({ staticDir: path.resolve(__dirname, "public") });

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
