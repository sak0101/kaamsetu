# Demo data

`scripts/seed-demo.mjs` provisions a realistic, clearly fictional marketplace for demos and judging: one employer, six workers, ten upcoming jobs across Vadodara localities, applications, confirmed bookings, two job addresses and (optionally) one finished job with ratings.

**Nothing in this repository runs it for you.** It is never part of `npm start`, the build, the packaging or any test against a hosted project.

## Safety rules (enforced in code, covered by tests)

1. It refuses unless `SUPABASE_URL` is **exactly** `https://praqzylbpqanqexhputi.supabase.co`. A local URL, another project, a look-alike host, plain `http` or a missing URL are all refused. There is no override.
2. It also refuses unless you pass `--confirm=praqzylbpqanqexhputi`.
3. Passwords come only from `DEMO_PASSWORD_EMPLOYER` and `DEMO_PASSWORD_WORKER` (12+ characters each). They are never printed or stored.
4. It uses the supported write path only: the Supabase Auth admin API for accounts, and the same database functions the API uses. It never writes to a table directly.
5. It is **idempotent**. Accounts are matched by email, jobs by title for the demo employer, applications and bookings by their existing rows. A second run creates nothing.

## How the data is marked

- Every account uses the reserved domain `@kaamsetu.invalid` (nothing can be delivered there) and a name ending in `(Demo)`.
- Every job description ends with `[Demo data]`.
- Phone numbers are fictional (`+91900000…`) and are shared only through the normal "live booking" rule.

| Account | Email |
|---|---|
| Employer | `demo.employer@kaamsetu.invalid` |
| Workers | `demo.worker1@kaamsetu.invalid` … `demo.worker6@kaamsetu.invalid` |

The workers differ on purpose: different areas and work types, one with no stated experience (shown as "not provided", never as zero), one with six years. The jobs include one starting later today, one tomorrow with an address and 2 of 8 workers booked, each kind of event (wedding, catering, puja, exhibition, corporate) and other types of work.

## Run it

Run `npm install` once first (the script uses the repository's `@supabase/supabase-js`).

```bash
# 1. See the plan. Connects to nothing.
node scripts/seed-demo.mjs --dry-run

# 2. Create it (set the variables in your shell; do not put them in a file that is committed)
export SUPABASE_URL=https://praqzylbpqanqexhputi.supabase.co
export SUPABASE_ANON_KEY=...            # the project's anon key
export SUPABASE_SERVICE_ROLE_KEY=...    # SECRET
export DEMO_PASSWORD_EMPLOYER=...       # choose; 12+ characters
export DEMO_PASSWORD_WORKER=...         # choose; 12+ characters
node scripts/seed-demo.mjs --confirm=praqzylbpqanqexhputi
```

Options: `--with-history` also creates one finished job with ratings (it is created to start in about 40 seconds, booked, then completed, so the run takes about 45 seconds longer); `--reset-passwords` sets the demo passwords again on accounts that already exist; `--cleanup` cancels the demo jobs.

**Requirements:** all database migrations through `20261120100004_matching_job_notifications.sql` must already be applied. If the job-location function is missing, the addresses are skipped with a message instead of failing.

If an account already exists with a different password you will get a clear message; re-run with `--reset-passwords`.

## Clean up

`node scripts/seed-demo.mjs --confirm=praqzylbpqanqexhputi --cleanup` cancels every open demo job (their applications are declined and bookings cancelled by the database). It leaves the accounts and the cancelled rows. To remove everything, run this in the Supabase SQL editor as the owner:

```sql
delete from public.notifications  where user_id in (select id from auth.users where email like '%@kaamsetu.invalid');
delete from public.booking_reviews where reviewer_id in (select id from auth.users where email like '%@kaamsetu.invalid');
delete from public.bookings        where employer_id in (select id from auth.users where email like '%@kaamsetu.invalid');
delete from public.job_applications where job_id in (select id from public.jobs where employer_id in (select id from auth.users where email like '%@kaamsetu.invalid'));
delete from public.jobs            where employer_id in (select id from auth.users where email like '%@kaamsetu.invalid');
delete from auth.users             where email like '%@kaamsetu.invalid';
```

## Rehearsing locally

The script itself will not run against the local stack (rule 1). The provisioning logic is exercised against the local stack by `npm run test:integration -w @kaamsetu/api` (it runs the provisioner twice and checks the second run creates nothing) and by the unit tests in `apps/api/src/demo.test.ts` (the guard and the data).
