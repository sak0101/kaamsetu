# Local setup

## Prerequisites

- Node.js 22 (production target is Node 22 on GoDaddy Node.js Hosting)
- npm 10+
- Git
- (Later phases) Supabase CLI, used for committed SQL migrations

## First run

```bash
npm install
cp .env.example .env     # fill in values as services are configured; never commit .env
npm run dev              # web on :5173, api on :3001 (Vite proxies /api)
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + API with hot reload |
| `npm test` | Unit tests across workspaces |
| `npm run typecheck` | TypeScript checks across workspaces |
| `npm run build` | Build web (Vite) and bundle api (esbuild) |
| `npm run stage` | Build, then assemble `dist-deploy/` (no ZIP) |
| `npm start` | Run the staged production app from `dist-deploy/` (run `npm run stage` first) |
| `npm run package` | Build, assemble `dist-deploy/`, create and validate `kaamsetu-deploy.zip` |
| `npm run verify:deploy` | Unzip the ZIP into a temp dir and run `npm install`, `build`, `start` against it |

## Supabase (planned)

Schema changes go in `supabase/migrations/` via the Supabase CLI and are committed. You will run `supabase login` and `supabase link` yourself, so credentials never pass through tooling or chat.
