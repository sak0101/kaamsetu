# Frontend (React + Vite + Tailwind) — Phase 1

Mobile-first, English-only MVP. Talks only to the Express API in [api.md](api.md).

## Data rules

- **All application data goes through `/api/*`** (`src/lib/api.ts`, one function per documented endpoint).
- The **Supabase browser client is used only for authentication and Realtime** (`src/lib/supabase.ts`, `auth.tsx`, `notifications.tsx`). Its URL and anon key are fetched at runtime from `GET /api/public-config`, so nothing is baked into the build. The service-role key never reaches the browser.
- The access token is read from the Supabase session for each API call; a 401 signs the user out.
- Architecture tests (`src/test/shell.test.tsx`) fail the build if production code calls `.from()/.rpc()`, uses `fetch` outside `lib/api.ts`, mentions a service-role key, hard-codes Supabase keys/URLs, or imports test code.

## Screens

| Route | Role | Screen |
|---|---|---|
| `/` | public | Landing (how it works, illustration clearly marked as not a real listing) |
| `/login`, `/signup` | public | Supabase Auth; sign-up sends `{ role, full_name }` as metadata |
| `/worker` | worker | Find work: filter by type/locality (defaults to the worker's area), text search over loaded jobs |
| `/worker/jobs/:id` | worker | Job detail, apply with message, withdraw, re-apply |
| `/worker/applications` | worker | Applications with status/reason, withdraw |
| `/worker/bookings`, `/employer/bookings` | both | Bookings, cancel with reason (rules mirror the database) |
| `/worker/profile` | worker | Name, area, up to 5 work types, optional experience, availability |
| `/employer` | employer | My jobs with booked counts and waiting-applicant counts |
| `/employer/jobs/new` | employer | Post a job (IST date/times, pay in ₹ → paise) |
| `/employer/jobs/:id` | employer | Job + applicants (evidence only), accept/decline, cancel job |
| `/employer/profile` | employer | Name and business |
| `/notifications` | both | List, mark read; bell badge + Realtime toast |

## Design

Palette: terracotta `#D97745`, deep indigo `#243B53`, marigold `#D9A441`, warm cream `#EDE5D5` (tokens in `src/styles.css`).
White text uses `terracotta-dark #B85C2E` (4.6:1) because raw terracotta is only ~3.1:1 with white. Visible focus ring, 44 px touch targets, skip link, labelled fields with `aria-describedby` errors, `role=alert/status` feedback, reduced-motion respected.

## Commands

```
npm run dev -w @kaamsetu/web      # Vite on :5173 (proxies /api to :3001); run the API too
npm test -w @kaamsetu/web         # Vitest + Testing Library (no network, no Supabase)
```
