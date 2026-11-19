# KaamSetu

A hyperlocal marketplace connecting people who need **manual, short-term work** (loading, furniture shifting, cleaning, event help, construction helpers) with **nearby workers** available for daily-wage and hourly jobs. Initial city: Vadodara, Gujarat.

Employers (people or businesses needing a few hands) post a job, workers nearby apply, the employer compares applicants with plain-language reasons and chooses, a booking is confirmed, the work is recorded as completed (or a no-show) and both sides can leave an honest rating.

## What is in the product

| Area | What it does |
|---|---|
| Accounts | Email + password sign-up with email confirmation, log in, **forgot / reset password**. Roles: worker, employer. |
| Employers | Post a job with a form or **describe it in words (typed or spoken, English / Hindi / Gujarati / Hinglish)** and review an AI draft before publishing. Optional exact address and landmark. Compare applicants, accept or decline, record completed / no-show, rate workers. |
| Workers | Find work with **server-side search** (words, locality, type of work, day, how long). "Ask in your own words" (voice or text, four languages). **Describe yourself** to draft a profile. Apply, track applications, see the address and a **Google Maps directions link** once booked, rate employers. |
| Trust | Applicant "fit" is a transparent, explainable summary of facts; missing data is never counted against a worker; ratings and no-shows come only from completed bookings and are never added to the match. Employers always decide. |
| Safety | Overbooking and double-booking are impossible (enforced inside the database). Phone numbers and job addresses are shared only with someone holding a live booking. No Aadhaar or ID numbers. |
| Notifications | In-app (with Realtime and polling): applications, bookings, cancellations, and **new jobs that match a worker's area and work types**. |
| Contact | A footer contact form delivering to `info@kaamsetu.tech` over SMTP, with the address always visible as a fallback. |

## Stack

React + TypeScript + Vite + Tailwind (web) · Node.js 22 + Express + TypeScript (api) · Supabase (PostgreSQL, Auth, Realtime) · Anthropic Claude (server-side only) · Nodemailer (contact form) · GoDaddy Node.js Hosting.

## Repository layout

```
apps/web         React SPA (mobile-first)
apps/api         Express API; also serves the compiled SPA in production
packages/shared  Types shared by both
supabase/        SQL migrations, pgTAP tests, concurrency tests, email templates, local config
scripts/         Deployment packaging + verification, demo-data provisioner
docs/            Setup, API, database, AI, deployment and demo documentation
```

The repo is a development monorepo. **The deployable application is generated** into `dist-deploy/` and zipped by `npm run package`; see [docs/deployment-godaddy.md](docs/deployment-godaddy.md).

## Architecture in one paragraph

The browser uses Supabase **only for sign-in and Realtime**; every read and write of application data goes through the Express API (`/api/*`). Express verifies the user's token with Supabase Auth, takes the user id only from that verified result, reads under the user's own token (so row-level security applies) and writes only by calling an allow-list of `SECURITY DEFINER` database functions as the service role. The AI (Claude) is called only from the server and only ever returns **drafts** that a person reviews. See [docs/api.md](docs/api.md) and [docs/database.md](docs/database.md).

## Quick start (local)

Requires Node 22. Docker Desktop is needed only for the local database and database tests.

```bash
npm install
cp .env.example .env            # then fill in values; .env is git-ignored and never packaged
npx supabase start -x studio,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor,storage-api
npx supabase db reset --local   # applies every migration
npm run dev                     # web on :5173, API on :3001
```

Point `.env` at the **local** stack (`npx supabase status -o env` prints the URL and keys). Without `ANTHROPIC_API_KEY` the AI features answer "not set up" and everything else works. Without the four `SMTP_*` variables the contact form shows the email address instead. Full setup: [docs/setup.md](docs/setup.md).

## Environment variables

See [.env.example](.env.example) (documentation only, no values). Required in production: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` (set by GoDaddy), `NODE_ENV=production`. Optional: `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `CONTACT_TO`, `TRUST_PROXY_HOPS`. The service-role key and every secret are server-only.

## Testing

| Command | What it covers |
|---|---|
| `npm test` | Unit and component tests: API (Express, validation, AI prompts and validation, mailer, rate limits) and web (Testing Library). No network. |
| `npm run typecheck` | TypeScript across workspaces. |
| `npx supabase test db` | pgTAP: privileges, RLS, state machines, counters, locations, reviews, notifications. Needs the local stack. |
| `node supabase/tests/concurrency/run.mjs` | Parallel-session race tests: no overbooking, no double-booking, no deadlocks. |
| `npm run test:integration -w @kaamsetu/api` | Real Express against the local database (search, privacy, lifecycle, demo data). |
| `npm run e2e -w @kaamsetu/web` | Real Edge browser journeys against the local stack (AI through a local stub of the Anthropic API). |
| `npm run qa -w @kaamsetu/web` | Broader QA suite including mobile overflow and security checks. |

## Demo data

`node scripts/seed-demo.mjs --dry-run` shows what it would create. It only ever runs against one named project, behind an explicit confirmation flag. See [docs/demo-data.md](docs/demo-data.md).

## Deployment

`npm run package` builds and produces `kaamsetu-deploy.zip`; `npm run verify:deploy` installs and boots that ZIP in a clean temp directory. **Order matters for a release: apply the database migrations first, then deploy the app.** The exact hosted Supabase and GoDaddy settings still required are listed in [docs/deployment-godaddy.md](docs/deployment-godaddy.md) and [docs/auth-email-setup.md](docs/auth-email-setup.md). Nothing in this repository deploys by itself.

## Language support and review

English, Hindi, Gujarati and Hinglish are supported for AI drafting, voice input and voice search. **The Hindi and Gujarati wording (work-type names, keyword lists, place-name spellings) is first-pass and must be reviewed by native speakers before it is relied on.**

## Photos and images

All pictures are original illustrations made for KaamSetu (see `apps/web/public/images`). No third-party photographs are used; [/credits](apps/web/src/pages/Credits.tsx) lists any that are ever added.

## Security

Secrets are read only from environment variables. `.env` files are git-ignored and excluded from the deployment ZIP; the packaging script fails if it detects one. The Anthropic key and Supabase service-role key are server-only. See [docs/database.md](docs/database.md) for the privilege and RLS model.
