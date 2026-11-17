# GoDaddy Node.js Hosting: deployment architecture

## Platform contract (as provided by the project owner)

- Node.js 22.
- GoDaddy runs `npm install`, then `npm run build`, then `npm start`.
- Single Node.js application; listens on `process.env.PORT`.
- ZIP limit: 100 MB.
- Secrets are configured in GoDaddy's environment-variable settings, not in the ZIP.

## One app from a monorepo

The development repo stays a monorepo. `npm run package` generates a separate, self-contained directory and ZIP:

```
kaamsetu-deploy.zip   (files at the ZIP root; no enclosing folder)
├─ package.json        generated; name, version, main, scripts.build, scripts.start, dependencies
├─ package-lock.json   generated from the manifest above
├─ server.js           Express API bundled by esbuild (one file, CommonJS, target node22)
├─ check-build.js      used by `npm run build` on GoDaddy
└─ public/             compiled Vite frontend
```

### Packaging pipeline (`scripts/package-deploy.mjs`)

1. `vite build` compiles the SPA; `esbuild` bundles `apps/api` + `packages/shared` into `server.js`. Runtime npm packages stay external.
2. The script assembles `dist-deploy/` from the build output.
3. It **generates** `package.json` from the api workspace: runtime `dependencies` copied verbatim; no devDependencies; `@kaamsetu/*` workspace packages are never listed (they are bundled).
4. `npm install --package-lock-only` produces `package-lock.json` for that manifest.
5. It creates `kaamsetu-deploy.zip` with `/`-separated entry paths.
6. It validates the ZIP and fails on any problem: required root files present, no enclosing folder, no `node_modules`/`.git`/`.env*`/key files/source maps, size under the limit, and no secret-like strings (Anthropic keys, JWT-shaped tokens).

### Why the `build` script in the ZIP only verifies

GoDaddy runs `npm run build` on the server, but the frontend is compiled **before** packaging so the server needs no dev tools (Vite, TypeScript, Tailwind) and `npm install` stays small and fast. The generated `build` script (`node check-build.js`) confirms that `server.js` and `public/index.html` exist and fails loudly otherwise. If we later prefer to compile on GoDaddy, this changes in one place (the generator).

### Runtime rules

- `PORT` comes from `process.env.PORT`. In production a missing/invalid `PORT` is a startup error. A `3001` fallback exists only when `NODE_ENV` is not `production`.
- Express serves `/api/*`, then static files from `public/` (resolved relative to `server.js`), then `index.html` for other GET requests so client-side routes work.
- Realtime goes directly from the browser to Supabase. The Node process holds no long-lived connections.
- The Supabase URL and anon key reach the browser at runtime from the server's environment (planned `/api/public-config`), so they are set once in GoDaddy's env settings and are not baked into the build.

## Not yet verified

Hello-world phase verifies the ZIP locally only. Nothing has been uploaded to GoDaddy. Still to confirm on the real platform: how env vars are entered, what HTTPS/domain steps are needed, whether outbound SMTP to Titan works, and the app-root/entry-point settings.
