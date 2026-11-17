# KaamSetu

A hyperlocal marketplace connecting people who need **manual, short-term work** (loading, furniture shifting, cleaning, event help, construction helpers) with **nearby workers** available for daily-wage and hourly jobs. Initial city: Vadodara, Gujarat.

Built for the GoDaddy Innovation Hackathon 2026.

> **Status:** foundation only. The product is not implemented yet. Nothing in this repository is deployed.

## Core journey

Employer posts work → workers discover and apply → employer compares applicants (transparent, deterministic scoring; employer decides) → booking confirmed → work completed → feedback recorded.

## Stack

React + TypeScript + Vite + Tailwind (web) · Node.js 22 + Express + TypeScript (api) · Supabase (PostgreSQL, Auth, Realtime) · Anthropic Claude (server-side only) · GoDaddy Node.js Hosting.

## Repository layout

```
apps/web         React SPA
apps/api         Express API; also serves the compiled SPA in production
packages/shared  Types/schemas shared by both
scripts/         Deployment packaging + verification
docs/            Setup and deployment documentation
supabase/        (planned) CLI migrations, committed
```

The repo is a development monorepo. **The deployable application is generated** into `dist-deploy/` and zipped by `npm run package`; see [docs/deployment-godaddy.md](docs/deployment-godaddy.md).

## Quick start

See [docs/setup.md](docs/setup.md). In short: Node 22, `npm install`, copy `.env.example` to `.env`, `npm run dev`.

## Security

Secrets are read only from environment variables. `.env` files are git-ignored and excluded from the deployment ZIP; the packaging script fails if it detects one. The Anthropic key and Supabase service-role key are server-only.
