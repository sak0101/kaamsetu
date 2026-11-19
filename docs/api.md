# KaamSetu API (Express) — Phase 1

All routes are under `/api`, return JSON, and (except the public routes `/api/health`, `/api/public-config` and `/api/contact`) require `Authorization: Bearer <Supabase access token>`.
Database contract: [database.md](database.md). Nothing here is deployed.

## Security model

- **Authentication**: the bearer token is verified with Supabase Auth (`auth.getUser(jwt)`); nothing is decoded locally.
- **Actor identity**: the user id is `user.id` from that verified result only. Request bodies, query strings and headers can never name the acting user (bodies/queries are strict Zod schemas: unknown keys such as `user_id`, `employer_id`, `p_actor`, `role` return 422).
- **Three separate Supabase clients** (`src/supabase.ts`):
  1. auth client (anon key): `auth.getUser` only;
  2. service client (service-role key): `rpc()` on the 11 allow-listed functions only (`p_actor` is injected last, so it cannot be overridden);
  3. per-request user client (anon key + the caller's JWT): reads under RLS.
- **Roles**: the role comes from the caller's own `profiles` row. Role-restricted routes fail fast with 403 `wrong_role`; the database re-checks on every mutation.
- **Suspension**: `is_suspended` is not readable by clients, so it is enforced inside every database mutation and returned as 403 `account_suspended`.
- **Errors**: `{ "error": { "code", "message", "details?" } }`. Database codes map to 401/403/404/409/422; unexpected errors return a generic 500 and never include database text.
- Required env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (mandatory in production; https required).

## Endpoints

| Method & path | Role | Database call |
|---|---|---|
| `GET /api/health` | public | — |
| `GET /api/public-config` | public | none: returns `{ supabaseUrl, supabaseAnonKey }` (browser-safe values only) so the SPA can create its Supabase auth client at runtime; the service-role key is never included |
| `POST /api/contact` | public | none: emails `{ name, email, message }` to `CONTACT_TO` (default `info@kaamsetu.tech`) over SMTP. Independent of Supabase (works without it). Strict schema + hidden `website` honeypot (a filled honeypot returns 202 and sends nothing); 5 messages per client and 60 in total per hour (429 `contact_rate_limited`); 8 KB body limit. 202 `{ ok: true }`; 503 `contact_not_configured` when SMTP is not set; 502 `contact_failed` when sending fails. From is the authenticated mailbox, Reply-To is the visitor. Names, addresses and message text are never logged |
| `GET /api/me` | any | reads `profiles`, `worker_profiles`, `worker_categories` |
| `PUT /api/me/profile` | any | `update_profile` |
| `PUT /api/me/worker-profile` | worker | `save_worker_profile` (bio, years, locality, categories, skills ≤8, availability note) |
| `GET /api/categories`, `GET /api/localities` | any | reads |
| `POST /api/jobs` | employer | `create_job` → `201 { id }` |
| `GET /api/jobs?locality_id&category_id&limit&offset` | worker | reads open, future jobs (+ employer name) |
| `GET /api/employer/jobs?limit&offset` | employer | reads own jobs |
| `GET /api/jobs?locality_id&category_id&q&date_from&date_to&min_hours&max_hours&limit&offset` | worker | reads under RLS, **all filters applied by the server over every open job**: `q` = words that must each appear in the title, description or employer name (at most 4 words; filter-grammar characters are neutralised); `date_from`/`date_to` = inclusive IST dates (`YYYY-MM-DD`); `min_hours`/`max_hours` use the generated `jobs.duration_minutes` column (migration 13) and are referenced only when given. Never returns an address. |
| `GET /api/jobs/:id` | any | reads under RLS (404 if not visible) |
| `POST /api/jobs/:id/cancel` `{reason?}` | employer | `cancel_job` → 204 |
| `POST /api/jobs/:id/applications` `{message?}` | worker | `apply_to_job` → `201 { application_id }` |
| `GET /api/me/applications` | worker | reads |
| `POST /api/applications/:id/withdraw` | worker | `withdraw_application` → 204 |
| `GET /api/jobs/:id/applicants` | employer | `get_applicant_signals` (facts + a transparent fit: see docs/ai-and-voice.md) |
| `POST /api/applications/:id/accept` | employer | `accept_application` → `201 { booking_id }` |
| `POST /api/applications/:id/reject` `{reason?}` | employer | `reject_application` → 204 |
| `GET /api/jobs/:id/location` | any | reads `job_locations` under RLS → `{ location: { address_line, landmark } \| null }`. Only the owning employer and a worker with a LIVE booking (confirmed / in progress, job not ended) get a value; everyone else gets `null` (indistinguishable from "no address added"). |
| `PUT /api/jobs/:id/location` `{address_line, landmark?}` | employer | `save_job_location` (own, non-cancelled jobs; blank address clears it; address 5–200 chars, landmark ≤ 100) → `{ location }` |
| `GET /api/me/bookings` | any | reads under RLS |
| `POST /api/bookings/:id/finish` `{outcome: "completed" \| "no_show"}` | employer | `finish_booking` (only after the job has started) → 204 |
| `POST /api/bookings/:id/review` `{rating 1–5, comment?}` | worker or employer | `submit_review` (completed bookings only, one per person; the reviewee is derived from the booking) → `201 { id }` |
| `GET /api/me/reviews` | any | reads reviews you wrote or received (RLS) |
| `POST /api/bookings/:id/cancel` `{reason?}` | worker or employer | `cancel_booking` → 204 |
| `GET /api/notifications?unread=true&limit&offset` | any | reads |
| `POST /api/notifications/read` `{ids?}` | any | `mark_notifications_read` → `{ updated }` |
| `GET /api/me/contact` | any | reads own phone (row-level security) → `{ phone }` |
| `PUT /api/me/contact` `{phone}` | any | `save_contact` (Indian mobile, stored as +91…; `null` clears) |
| `GET /api/bookings/:id/contact` | worker or employer | reads the OTHER side's phone, only while the booking is confirmed or in progress → `{ name, phone, shared }` |
| `GET /api/ai/status` | any | `{ available }`: whether AI drafting is configured |
| `POST /api/ai/worker-profile-draft` `{text}` | worker | Claude (server-side). Returns a profile DRAFT only (`draft`, `assumptions`, `questions`, `missing_fields`); nothing is saved. The worker applies it to the form, edits it and saves through `PUT /api/me/worker-profile`. Shares the 12-per-10-minutes AI limit. |
| `POST /api/ai/job-draft` `{text, answers?}` | employer | Claude (server-side). Returns a DRAFT only (`draft`, `assumptions`, `questions`, `ready`); it never creates a job. 503 `ai_not_configured` without a key; 12 drafts / 10 min / user |

Times are ISO-8601 **with an offset** (send IST as `+05:30`); money is integer paise (INR, max 5,000,000).
Lists accept `limit` (1–50, default 20) and `offset`.

## Tests

```
npm test -w @kaamsetu/api                    # unit tests, fakes, no database or Docker
npm run test:integration -w @kaamsetu/api    # real Express + local Supabase stack (needs `supabase start`)
```
