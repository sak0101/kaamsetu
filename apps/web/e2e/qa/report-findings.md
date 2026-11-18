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
