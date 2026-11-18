# Database (Supabase / PostgreSQL) — Phase 1

Migrations: `supabase/migrations/` (apply order = filename order). Tests: `supabase/tests/`.
**Nothing here has been applied to the hosted project.**

## Write-path contract (Express only)

- **Browser**: Supabase Auth (sign-up/sign-in), `SELECT` under RLS with the user's JWT, and Realtime. No INSERT/UPDATE/DELETE grants, no write policies, no EXECUTE on any API function.
- **Express** uses **two separate clients**:
  1. an *auth client* (anon/publishable key) used only to call `auth.getUser(jwt)`;
  2. a *service client* (service-role key, `persistSession: false`) used only for `rpc(...)` calls.
- The **actor uid comes exclusively from a successful `auth.getUser(jwt)`** (`data.user.id`). Never from a request body, header, query string, or an unverified decoded JWT. Pass it as `p_actor`.
- `service_role` has **no table privileges at all**: it can only call the 12 API functions. Read through the user's JWT client (RLS) or `get_applicant_signals`.
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
