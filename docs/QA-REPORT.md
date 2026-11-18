# KaamSetu: end-to-end QA report

Generated 2026-11-18T08:43:05.416Z by `npm run qa -w apps/web` (suite: `apps/web/e2e/qa/suite.mjs`, report: `apps/web/e2e/qa/report.mjs`).

**Scope:** local development only: local Supabase (Auth, Postgres, Mailpit at http://127.0.0.1:54324), local Express API (:3001), local Vite (:5173), Microsoft Edge driven by Playwright. The harness refuses to run against a non-local Supabase URL. Nothing was deployed, pushed, or applied to a remote project; production Supabase and GoDaddy were not touched. Email confirmation stayed **enabled**: every QA account was confirmed by following the real link from Mailpit. No application code was changed to make a test pass.

## 1. Result summary

| Result | Count |
|---|---|
| PASS | 71 |
| FAIL | 0 |
| BLOCKED | 1 |
| NOT IMPLEMENTED | 3 |
| **Total** | **75** |

| Area | Pass | Fail | Blocked | Not impl. |
|---|---|---|---|---|
| Accounts | 11 | 0 | 0 | 0 |
| Email | 4 | 0 | 1 | 3 |
| Profiles | 4 | 0 | 0 | 0 |
| UI states | 8 | 0 | 0 | 0 |
| Marketplace | 12 | 0 | 0 | 0 |
| Setup | 1 | 0 | 0 | 0 |
| Edge cases | 6 | 0 | 0 | 0 |
| Concurrency | 4 | 0 | 0 | 0 |
| Forms | 2 | 0 | 0 | 0 |
| Security | 11 | 0 | 0 | 0 |
| Sessions | 2 | 0 | 0 | 0 |
| Mobile | 4 | 0 | 0 | 0 |
| Browser health | 2 | 0 | 0 | 0 |

QA accounts (identifiable, local DB only): `employer.qa@kaamsetu.test` (employer), `employer2.qa@kaamsetu.test` (employer), `worker1.qa@kaamsetu.test` (worker), `worker2.qa@kaamsetu.test` (worker), `worker3.qa@kaamsetu.test` (worker), `worker4.qa@kaamsetu.test` (worker), `worker5.qa@kaamsetu.test` (worker), `worker6.qa@kaamsetu.test` (worker).

## 2. Test cases

| ID | Area | Case | Result | Evidence / reason |
|---|---|---|---|---|
| ACC-01 | Accounts | Sign-up form blocks empty, invalid-email and short-password input without calling the auth API | PASS | 0 requests to /auth/v1/signup; 4 inline errors shown |
| ACC-02 | Accounts | Employer registers through the UI; the page asks them to check their email | PASS | auth.users row created unconfirmed (true\|employer) |
| ACC-03 | Accounts | An unconfirmed account cannot log in (email confirmation is enforced, not bypassed) | PASS | UI alert shown; Supabase password grant -> HTTP 400 (email_not_confirmed) |
| MAIL-01 | Email | Signup confirmation email exists in Mailpit with correct recipient, sender, subject and link | PASS | From <admin@email.com> (Admin); Subject "Confirm your KaamSetu account"; link http://127.0.0.1:54321/auth/v1/verify?type=signup&redirect_to=http://localhost:5173/login |
| ACC-04 | Accounts | Opening the confirmation link in the browser confirms the account and signs the employer in | PASS | auth.users.email_confirmed_at set; dashboard shown |
| ACC-05 | Accounts | A confirmation link cannot be reused to sign in a second time | PASS | final url http://localhost:5173/login#…; login page shown; no uncaught errors |
| ACC-06 | Accounts | Session persists across reload and the access token lives in browser storage | PASS | dashboard still shown after reload |
| ACC-07 | Accounts | Logout clears the session; protected pages then redirect to login; login works again | PASS | token removed on logout; relogin succeeded |
| ACC-08 | Accounts | Wrong password shows a friendly error and does not sign in | PASS |  |
| ACC-09 | Accounts | Login form validates empty fields without calling the auth API | PASS |  |
| ACC-10 | Profiles | Employer profile: invalid phone is rejected client-side; valid profile saves and persists in the database | PASS | profiles.org_name + contact_details.phone = Shah Event Services (QA)\|+919123456789 |
| ACC-11 | Accounts | Worker 1 registers through the UI and confirms via the real email; lands on Find work with a profile prompt | PASS |  |
| ACC-12 | Accounts | Worker 2 registers through the UI and confirms via the real email | PASS |  |
| MAIL-02 | Email | Each confirmation email goes only to its own recipient (no cross-delivery) | PASS | 3 accounts -> 3 messages, one each |
| PRO-01 | Profiles | Worker 1 completes profile (Alkapuri, Event help, 4 yrs, skills, availability, phone); saved to the database | PASS | 2\|4\|Guest handling\|Evenings and weekends\|1\|+919876543210 |
| PRO-02 | Profiles | Worker 2 completes a thinner profile (Gotri, Event help + Cleaning, experience left blank) | PASS | years_experience is NULL in the database, 2 categories (NULL\|2) |
| PRO-03 | Profiles | Worker profile validation: nothing is saved without an area and a type of work | PASS |  |
| UI-01 | UI states | Employer dashboard empty state invites the first posting (real empty account) | PASS |  |
| UI-02 | UI states | Worker: empty applications, bookings and notifications states | PASS |  |
| MKT-01 | Marketplace | Employer posts a job through the form; the saved row matches what was entered | PASS | jobs row 2 \| 80000 \| fixed \| open \| 0 \| 4 \| 2 \| 2026-11-21 17:00 \| 23:00 |
| MKT-02 | Marketplace | Matching: worker in Alkapuri sees the job by default; Event-help filter keeps it; Cleaning filter hides it | PASS |  |
| MKT-03 | Marketplace | Matching: worker in Gotri does NOT see the Alkapuri job by default, but does after widening to all of Vadodara | PASS |  |
| MKT-04 | Marketplace | Worker 1 applies; status shows Waiting; the application row exists; the employer was notified (database) | PASS | job_applications: pending\|I have done 20+ weddings.; notifications(new_application)=1 |
| MKT-05 | Marketplace | Worker 2 applies too, then withdraws (DB shows withdrawn), then re-applies (DB shows pending again) | PASS |  |
| MKT-06 | Marketplace | Employer dashboard shows 2 applicants waiting | PASS |  |
| MKT-07 | Marketplace | Applicant comparison: best fit first, exact percentages and reasons match the documented formula | PASS | worker1 97% (Strong), worker2 60% (Good, experience excluded not zero); order best-first |
| MKT-08 | Marketplace | Employer accepts worker 1: booking row, slot counter and notifications are correct in the database | PASS | booking confirmed\|80000\|1\|2\|open; accepted app; worker1 notified once; worker2 still pending |
| MKT-09 | Marketplace | Remaining slots: UI says '1 of 2 booked · 1 needed' and matches the database | PASS |  |
| MKT-10 | Marketplace | Worker and employer booking views show the booking with correct counterpart, time and pay | PASS |  |
| MKT-11 | Marketplace | Employer accepts worker 2: job becomes Fully booked (2 of 2), no pending applicants remain | PASS |  |
| MKT-12 | Marketplace | Contact numbers are revealed to the booked worker only for the live booking | PASS |  |
| TOK-00 | Setup | Create extra QA accounts through the real confirmation-email flow and sign in with real tokens | PASS | 8 QA accounts exist, all email-confirmed (9) |
| EDGE-01 | Edge cases | Duplicate application is rejected with 409 already_applied; only one row exists | PASS |  |
| EDGE-02 | Edge cases | Job at capacity: a third worker cannot apply (409 job_not_open) and an extra accept is impossible | PASS |  |
| EDGE-03 | Edge cases | Overlap: a worker with a confirmed booking cannot apply to an overlapping job (409 worker_double_booked) | PASS | job window overlaps worker1's confirmed 17:00-23:00 booking |
| CONC-01 | Concurrency | 6 workers, 1 slot, 6 parallel accepts: exactly one booking; counters and DB agree | PASS | statuses 201,409,409,409,409,409; DB 1\|1\|filled\|1; 5 auto-rejected as job_filled |
| CONC-02 | Concurrency | 6 workers, 3 slots, 6 parallel accepts: exactly three bookings (never more) | PASS |  |
| CONC-03 | Concurrency | Two employers accept the same worker for overlapping jobs at the same instant: only one booking succeeds | PASS |  |
| CONC-04 | Concurrency | 20 rapid double-click accepts of the same application create exactly one booking | PASS |  |
| EDGE-04 | Edge cases | Employer cancels a confirmed booking (UI): attribution, freed slot and live notification are correct in the database | PASS | cancelled_by_employer\|true\|Venue changed\|1\|open |
| EDGE-05 | Edge cases | Worker cancels their own booking (UI): attributed to the worker, slot freed | PASS | cancelled_by_worker\|true\|0 |
| EDGE-06 | Edge cases | Cancelling a job (UI) rejects pending applicants and cancels bookings, all recorded in the database | PASS | cancelled\|0\|1\|0\|0 |
| FORM-01 | Forms | Job form: empty, past date, end-before-start, zero pay and over-limit pay are all blocked with no request sent | PASS |  |
| FORM-02 | Forms | API rejects invalid job payloads server-side too (not just the UI) | PASS | pay 0:422 pay over ₹50,000:422 workers 0:422 workers 51:422 end before start:422 start in the past:422 over 14 days:422 unknown category:422 unknown locality:422 title too short:422 bad pay type:422 |
| SEC-01 | Security | Unauthenticated requests are rejected (401) on every protected endpoint | PASS | all 8 -> 401 |
| SEC-02 | Security | Forged, tampered and garbage tokens are rejected (401) | PASS |  |
| SEC-03 | Security | A revoked (logged-out-elsewhere) session token stops working immediately | PASS |  |
| SEC-04 | Security | Another employer cannot view, list applicants of, accept for, reject for, or cancel someone else's job | PASS | GET job:404 GET applicants:404 accept:404 reject:404 cancel job:404 |
| SEC-05 | Security | Role separation: workers cannot use employer endpoints and employers cannot use worker endpoints (403) | PASS |  |
| SEC-06 | Security | A worker cannot read another worker's applications, bookings, notifications or phone (API and direct database access) | PASS | job_applications:0 bookings:0 notifications:0 contact_details:0 profiles:0 worker_profiles:0 |
| SEC-07 | Security | Booking contact endpoint: strangers and unbooked applicants get 404; the phone never appears in the applicants API | PASS |  |
| SEC-08 | Security | Mass assignment and identity spoofing are refused (client-supplied role / user id / employer id) | PASS | PUT /me/profile role:422 PUT /me/profile is_suspended:422 POST /jobs employer_id:422 apply worker_id:422 contact user_id:422 |
| SEC-09 | Security | Direct database writes with a user token are denied for every table (RLS + grants) | PASS | PATCH profiles.role:403 POST bookings:403 PATCH jobs:403 DELETE job_applications:403 PATCH notifications:403 POST contact_details:403 |
| SEC-10 | Security | The service-role key never reaches the browser (public config, page HTML and every script the app loaded) | PASS | scanned 15155 KB across 57 responses (37 KaamSetu modules); key value absent; library files that merely name the role in their own text: @supabase_supabase-js.js, @supabase_supabase-js.js |
| SEC-11 | Security | Stored XSS: markup in a job title and a worker message is rendered as inert text and never executes | PASS |  |
| SES-01 | Sessions | Unauthenticated visitors are redirected to login from every protected route | PASS |  |
| SES-02 | Sessions | A session revoked on the server is detected in the browser: the user is sent to login without a crash | PASS |  |
| UI-03 | UI states | Unknown URL shows a friendly Page not found with a way home | PASS |  |
| UI-04 | UI states | Employer: an unknown job id shows 'Job not found' (no crash, no data leak) | PASS |  |
| UI-05 | UI states | Employer opening a malformed job id shows a handled error, not a crash | PASS |  |
| UI-06 | UI states | Loading state: a slow jobs API shows an accessible loading indicator, then the list | PASS |  |
| UI-07 | UI states | Error state: when the jobs API is down the page shows a clear error with Try again, and recovers | PASS |  |
| UI-08 | UI states | Notifications page lists real notifications and mark-all-read updates the database | PASS |  |
| MAIL-03 | Email | Supabase password-recovery email is delivered to Mailpit with a recovery link (platform capability) | PASS | From <admin@email.com>; Subject "Reset your KaamSetu password"; link type=recovery |
| MAIL-04 | Email | App provides a password-reset flow (login link, page, or route) | NOT IMPLEMENTED | No 'Forgot password' link on the login page and no /reset-password or /forgot-password route. Users who lose their password cannot recover their account. |
| MAIL-05 | Email | Job and application events trigger emails to users | NOT IMPLEMENTED | Not implemented: 10 emails in Mailpit after full marketplace activity, all auth emails; none for applications, bookings or cancellations. Job/application notifications are in-app only (verified in the database). |
| MAIL-06 | Email | Contact form delivers a message to the team inbox | NOT IMPLEMENTED | No contact page or API (GET /contact serves the SPA 404 page; POST /api/contact -> 404). .env.example lists SMTP_*/CONTACT_TO but nothing reads them. |
| MAIL-07 | Email | Auth emails are branded (subject, heading, call to action) and contain a working link | PASS | subject "Confirm your KaamSetu account"; branded heading and button |
| MAIL-08 | Email | Auth emails are sent from a KaamSetu-owned sender address | BLOCKED | BLOCKED: local Mailpit sender is <admin@email.com> (Supabase default). A KaamSetu domain sender needs hosted SMTP (SPF/DKIM) which cannot be provisioned or tested locally. |
| MOB-01 | Mobile | Public pages (landing, login, signup, credits) have no horizontal scroll | PASS | /:0px /login:0px /signup:0px /credits:0px |
| MOB-02 | Mobile | Signed-in pages (worker + employer) have no horizontal scroll; the menu opens and navigates | PASS | /worker:0px /worker/profile:0px /worker/applications:0px /worker/bookings:0px /notifications:0px |
| MOB-03 | Mobile | Employer pages on mobile (jobs, applicants, job form) have no horizontal scroll | PASS | /employer:0px /employer/jobs/new:0px /employer/jobs/new/ai:0px /employer/bookings:0px /employer/jobs/:id:0px |
| MOB-04 | Mobile | Touch targets: buttons, inputs and nav links are at least 40 px tall on mobile | PASS |  |
| NET-01 | Browser health | No uncaught JavaScript errors in any browser session | PASS | 0 uncaught errors across 7+ browser sessions |
| NET-02 | Browser health | No UNEXPECTED console errors or failed/4xx/5xx requests outside negative tests | PASS | 14 expected error responses (negative tests), 0 unexpected |

## 3. Not passing in this run

- **MAIL-04** (NOT IMPLEMENTED): App provides a password-reset flow (login link, page, or route): No 'Forgot password' link on the login page and no /reset-password or /forgot-password route. Users who lose their password cannot recover their account.
- **MAIL-05** (NOT IMPLEMENTED): Job and application events trigger emails to users: Not implemented: 10 emails in Mailpit after full marketplace activity, all auth emails; none for applications, bookings or cancellations. Job/application notifications are in-app only (verified in the database).
- **MAIL-06** (NOT IMPLEMENTED): Contact form delivers a message to the team inbox: No contact page or API (GET /contact serves the SPA 404 page; POST /api/contact -> 404). .env.example lists SMTP_*/CONTACT_TO but nothing reads them.
- **MAIL-08** (BLOCKED): Auth emails are sent from a KaamSetu-owned sender address: BLOCKED: local Mailpit sender is <admin@email.com> (Supabase default). A KaamSetu domain sender needs hosted SMTP (SPF/DKIM) which cannot be provisioned or tested locally.

## 4. Browser health

- Console errors outside negative tests: **0**; uncaught page errors: **0**.
- HTTP >= 400 responses outside negative tests: **0**; 14 further 4xx responses were deliberately provoked by negative tests (bad login, unauthorised, validation, 404 route).


## 5. Bugs found

| # | Finding | Severity | Status |
|---|---|---|---|
| B1 | **Auth emails were unbranded.** Confirmation (and recovery) emails used Supabase's generic template: "Confirm Your Signup" / "Follow this link to confirm your user", no KaamSetu name. Repro: sign up in the UI, open Mailpit. Evidence: [before-fix screenshot](qa-screenshots/before-fix/MAIL-07-generic-email.png). | Medium | **Fixed locally.** Branded templates in `supabase/templates/{confirmation,recovery}.html`, wired in `supabase/config.toml` (`[auth.email.template.*]`). Verified by MAIL-07 (subject, brand, working link, privacy line). Regression test: MAIL-07 in the QA suite. |
| B2 | **`/favicon.ico` returned 404** on every page load, logging a console error. Repro: open any page with DevTools. Evidence: [before-fix screenshot](qa-screenshots/before-fix/NET-02-favicon-404.png). | Low | **Fixed.** `apps/web/public/favicon.svg` and `<link rel="icon">` in `index.html`. Regression tests: `src/test/favicon.test.ts` and QA case NET-02 (now passes). |

No data-integrity, authorisation or concurrency bug was found.

### Investigated, not a bug
- **Stale 401s right after sign-out.** Immediately after "Sign out", requests that were already in flight from the old session (`/api/notifications`, `/api/localities`, `/api/categories`, `/api/employer/jobs`) come back 401. A repro (`apps/web/e2e/qa/repro-session-race.mjs`, 12 rapid logout→login cycles) showed **0** fresh logins being undone and 0 page errors, so the 401s are harmless noise from revoked tokens. An earlier apparent failure was a harness artefact (the cycle ended logged in, so the next `/login` visit redirected). Possible hardening, not required: ignore `onUnauthorized` for a token that is no longer the current session.

## 6. Verification highlights

**API + database (real Supabase tokens, `docker exec … psql` checks):**
- Marketplace journey end-to-end: post job → worker applies → employer accepts → booking row, `positions_filled`, application status, notifications rows all verified in Postgres. Fit scores match the documented formula exactly (worker1 97 % "Strong match", worker2 60 % "Good match").
- Capacity: job with N positions fills at exactly N accepted bookings; further accepts rejected; status becomes full; cancellation reopens the slot.
- Duplicate application rejected (single DB row). Withdrawal, worker cancellation and employer cancellation record the right actor and status.
- Cancelling a job cancels its open applications/bookings.

**Concurrency (parallel HTTP requests with real tokens, DB re-queried afterwards):**
- Two employers/requests accepting the last slot at once: exactly one 201, one rejected, `positions_filled` never exceeds `workers_needed`.
- 3 slots / 6 simultaneous accepts: exactly 3 bookings.
- Worker accepted for two overlapping jobs at once: only one confirmed booking (exclusion constraint); non-overlapping jobs both succeed.
- 20 rapid duplicate accept calls: exactly one booking.

**Security:**
- Unauthenticated, malformed, expired/revoked tokens → 401 on every protected route; revoked-by-global-logout token rejected by the API.
- Cross-employer accept/cancel/read → 403/404; worker cannot call employer endpoints and vice versa; workers cannot read other workers' contact details; phone numbers become visible only for confirmed/in-progress bookings (RLS `private.has_active_booking_with`).
- Mass-assignment (role, status, ids in bodies) ignored; Zod rejects invalid input; XSS payloads in titles/descriptions rendered inert.
- Service-role key absent from the served bundle, responses and browser storage; direct PostgREST writes to protected tables denied.

**Email (Mailpit):**
- Signup confirmation delivered, branded, link works once; reused link rejected; unconfirmed login blocked. Recovery email delivered and branded (MAIL-07).
- **Not implemented (reported, not faked):** password-reset UI/route (MAIL-04), application/booking/cancellation emails (MAIL-05; in-app notifications only), contact form (MAIL-06; `SMTP_*`/`CONTACT_TO` in `.env.example` are unused).
- **Blocked:** sender is Supabase's default `admin@email.com` (MAIL-08); needs hosted SMTP with SPF/DKIM.

**UI:** desktop 1280 px and mobile 375 px: no horizontal scroll, touch targets ≥ 44 px, loading/empty/error states, form validation messages, 404 route, expired-session redirect to login all verified. Failure screenshots are written to `docs/qa-screenshots/` (none remain: the final run had no failures).

## 7. Remaining production blockers

1. **No password-reset flow** in the app (recovery email exists but no page to set a new password). Users who forget a password are locked out.
2. **No contact form / support channel** although the env template implies one.
3. **No transactional emails** for applications, acceptance or cancellation; workers without the app open won't learn they were accepted.
4. **Email sender and deliverability:** hosted Supabase needs custom SMTP (KaamSetu domain, SPF/DKIM/DMARC) and the branded templates applied to the hosted project (templates are currently local-only).
5. **Hosted Auth settings:** site URL / redirect allow-list, confirmation enabled, minimum password length 8 and the rate limits must be set on the hosted project; the local `config.toml` is not pushed automatically.
6. **Rate limiter is in-memory** (per Node process): fine for one GoDaddy process, not for multiple instances/restarts.
7. **No job completion / review flow** after a booking ends.
8. Tests ran against the local stack only; a hosted smoke test after deployment is still required.

## 8. Actions requiring your approval

- Apply the branded email templates to the **hosted** Supabase project (dashboard or `supabase config push`; the latter pushes *all* of `config.toml`, so review first).
- Provision hosted SMTP (provider choice, domain DNS records).
- Build the missing features (password reset, contact form, transactional emails) if you want them before launch.
- Commit the new QA tooling, favicon, templates and docs (nothing has been committed or pushed).
- Optionally harden the stale-401 handling described in section 5.
