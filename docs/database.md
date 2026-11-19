# Database (Supabase / PostgreSQL) — Phase 1

Migrations: `supabase/migrations/` (apply order = filename order). Tests: `supabase/tests/`.
**Hosted status:** migrations 1–12 (through `20261119100001_worker_profile_extras_and_contact.sql`) are already applied to the hosted project. Migrations 13–16 (`20261120100001` to `20261120100004`) exist locally and are **pending**: they have not been applied to the hosted project.

## Write-path contract (Express only)

- **Browser**: Supabase Auth (sign-up/sign-in), `SELECT` under RLS with the user's JWT, and Realtime. No INSERT/UPDATE/DELETE grants, no write policies, no EXECUTE on any API function.
- **Express** uses **two separate clients**:
  1. an *auth client* (anon/publishable key) used only to call `auth.getUser(jwt)`;
  2. a *service client* (service-role key, `persistSession: false`) used only for `rpc(...)` calls.
- The **actor uid comes exclusively from a successful `auth.getUser(jwt)`** (`data.user.id`). Never from a request body, header, query string, or an unverified decoded JWT. Pass it as `p_actor`.
- `service_role` has **no table privileges at all**: it can only call the API functions (15 after migration 15; the original 12 are listed below, the three added in migrations 14 and 15 are `save_job_location`, `finish_booking`, `submit_review`). Read through the user's JWT client (RLS) or `get_applicant_signals`.
- Frontend reads: `profiles` is column-restricted, so list columns explicitly (`select=id,role,full_name,…`); `select=*` is denied by design.

## API functions (public schema, EXECUTE: service_role only)

`update_profile`, `save_worker_profile`, `save_contact`, `create_job`, `cancel_job`, `apply_to_job`, `withdraw_application`,
`reject_application`, `accept_application`, `cancel_booking`, `mark_notifications_read`, `get_applicant_signals`.

Errors use SQLSTATE class `KS` with a stable machine code as the message:
`KS401` unauthenticated · `KS403` forbidden/wrong role/suspended · `KS404` not found (also "not yours") ·
`KS409` state conflict (`job_full`, `worker_double_booked`, `application_not_pending`, …) · `KS422` invalid input · `KS500` bad isolation level.
Check-constraint failures surface as `23514`. Map `KS404`→404, `KS403`→403, `KS409`→409, `KS422`/`23514`→422.

## Lock order (deadlock freedom)

`jobs row` → `worker advisory lock` → `job_applications rows (asc id)` → `bookings rows (asc id)`.

| Function | Locks acquired, in order |
|---|---|
| `apply_to_job` | job (SHARE) → worker → application |
| `withdraw_application` | job (SHARE) → application |
| `reject_application` | job (SHARE) → application |
| `accept_application` | job (UPDATE) → worker → application → insert booking |
| `cancel_booking` | job (UPDATE) → booking |
| `cancel_job` | job (UPDATE) → applications (asc id) → bookings (asc id) |

Cancellations take no worker lock (they only remove active bookings). All validation runs after the locks, under READ COMMITTED (functions refuse other isolation levels).

## Security notes

- Tables/functions owned by `postgres`; RLS is **enabled, not forced** (definer functions bypass it as owner; client roles never own anything). Locally `postgres` has `BYPASSRLS=true`, and the design does not depend on it.
- Every `SECURITY DEFINER` function pins `search_path = ''`; trigger/internal functions live in the unexposed `private` schema with no client grants.
- A statement trigger on every table rejects writes from `anon`/`authenticated`/`service_role` even if a grant is widened later.
- Admins are not part of Phase 1 (use the SQL editor as owner). No user metadata is ever trusted for privilege; signup whitelists `worker`/`employer`.
- No Aadhaar/DOB/gender/address data. Money is integer paise (INR). Timestamps are `timestamptz`.

## Local verification (requires Docker Desktop; local only)

```
npx supabase start -x studio,imgproxy,mailpit,postgres-meta,edge-runtime,logflare,vector,supavisor,storage-api
npx supabase db reset --local
npx supabase test db                       # pgTAP
node supabase/tests/concurrency/run.mjs    # parallel-session race tests
```

Production does **not** need Docker: Express talks to the hosted Supabase over HTTPS.

## Demo accounts

Create with the Auth admin API using `email_confirm: true` and `user_metadata: { role, full_name }` from a script that reads credentials from environment variables. Hosted email confirmation stays enabled.


## Migration 12: worker extras and contact phone

- `worker_profiles.skills` (≤ 8, 2–40 chars each, de-duplicated case-insensitively) and `availability_note` (≤ 120).
- `contact_details(user_id, phone)`: optional Indian mobile (`+91[6-9]xxxxxxxxx`). RLS: readable only by its owner or by the other side of a **confirmed / in-progress** booking (`private.has_active_booking_with`). Never visible to applicants, strangers or anon; sharing ends when the booking ends. Writes only through `save_contact`.
- `get_applicant_signals` also returns `bio`, `skills`, `availability_note`, `member_since` and `completed_jobs` (a real count of completed bookings, 0 for every new worker). Still no rating or score.


## Migrations 13 to 16 (additive; apply in order, before deploying the app that uses them)

| Migration | What it adds |
|---|---|
| `20261120100001_job_duration.sql` | `jobs.duration_minutes`, a generated column, so the API can filter by duration server-side. Read-only; no grant change. |
| `20261120100002_job_locations.sql` | `job_locations(job_id, address_line, landmark)` in its **own table** (jobs are readable by every worker). RLS: the owning employer, or a worker with a live booking whose job has not ended (`private.has_live_booking_on_job`). `save_job_location` is the only write path. |
| `20261120100003_completion_and_reviews.sql` | `finish_booking` (employer; `completed` or `no_show`; only after the job started; same lock order as `cancel_booking`), `booking_reviews` (one per booking and reviewer; completed bookings between exactly their two parties; immutable; readable only by reviewer and reviewee), `submit_review`. `get_applicant_signals` gains `no_show_count`, `review_count`, `avg_rating` (facts, NULL / 0 for new workers). |
| `20261120100004_matching_job_notifications.sql` | Widens the `notifications` type / entity checks and adds an AFTER INSERT trigger on `jobs` that notifies matching workers (same locality and category, available, not suspended, no overlapping live booking), capped at 100 per job, one per worker per job (partial unique index), payload = job id, title and locality only. |

Function count: **15** API functions (the original 12 plus `save_job_location`, `finish_booking`, `submit_review`). Cancellation attribution and the slot counters are unchanged: `completed` keeps its slot, `no_show` releases it, both through the existing triggers.

Design notes: the applicant-evidence test now allows `avg_rating` because it is a fact derived from genuine reviews; it still forbids any score, reliability, rank or prediction column. New workers have `review_count = 0` and `avg_rating = NULL` and are never penalised for it.

Tests: `supabase/tests/database/07_*`, `08_*`, `09_*` (and updated `01_*`, `03_*`), plus the unchanged concurrency suite.
