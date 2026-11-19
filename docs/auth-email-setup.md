# Auth emails and password recovery: what must be set on the hosted Supabase project

Nothing in this document has been applied to the hosted project. `supabase/config.toml` configures the **local** stack only; it is **not** pushed automatically, and `supabase config push` would push *all* of it (including `site_url = "http://localhost:5173"`), so do not run it blindly. Make these changes in the Supabase dashboard (Authentication) or review a config diff first.

## What the app does

| Flow | Where | Behaviour |
|---|---|---|
| Sign-up confirmation | `lib/auth.tsx` `signUp` | `emailRedirectTo` is `<origin>/login`. Email confirmation must stay **enabled**. |
| Forgot password | `/forgot-password` (`pages/ForgotPassword.tsx`) | Calls `resetPasswordForEmail(email, { redirectTo: <origin>/reset-password })`. Always answers "If there is a KaamSetu account…", so it never reveals which emails are registered. Only rate limits and network failures are shown. |
| Reset password | `/reset-password` (`pages/ResetPassword.tsx`) | Recognises a recovery link from the URL hash (`type=recovery`) **and** the `PASSWORD_RECOVERY` event. Expired or already-used links (`error_code=otp_expired` in the hash) show a clear message with a "Request a new reset link" action. On save it calls `updateUser({ password })`, signs the user out, and returns to `/login` with a success notice. Minimum 8 characters, confirmation must match. |

The recovery link logs the user in temporarily (that is how Supabase proves email ownership). The reset page is where they are sent; they are signed out as soon as the new password is saved, and they then log in normally.

## Required hosted settings (Authentication → URL Configuration)

1. **Site URL**: the production origin, e.g. `https://<your-domain>`.
2. **Redirect URLs** (allow-list): `https://<your-domain>/login` and `https://<your-domain>/reset-password` (or `https://<your-domain>/**`). If the recovery redirect is not allow-listed, Supabase falls back to the Site URL and the reset page is never reached.
3. Keep **Confirm email** enabled; minimum password length **8** (matches the app's validation).

## Required hosted settings (Authentication → SMTP / Emails)

Supabase's built-in mailer is meant for testing: it is heavily rate-limited and, on hosted projects, only delivers to addresses that belong to your project team. **Sign-up confirmation and password-reset emails to real users need custom SMTP.**

- Enable **Custom SMTP** with your mail provider's host, port, username and password (the same mailbox used for the contact form is fine, but these are *Supabase* settings; they are entered in the dashboard, not in GoDaddy's environment).
- Sender: a KaamSetu-owned address (for example `no-reply@kaamsetu.tech` or `info@kaamsetu.tech`), with SPF/DKIM set for the domain so mail is not marked as spam.
- Raise the email rate limit above the default once custom SMTP is on (Authentication → Rate Limits).

## Branded templates

`supabase/templates/confirmation.html` and `supabase/templates/recovery.html` are the KaamSetu-branded templates (subjects "Confirm your KaamSetu account" and "Reset your KaamSetu password"); `config.toml` wires them for the local stack. For the hosted project, paste the same HTML and subjects into Authentication → Email Templates (Confirm signup, Reset password). Both use `{{ .ConfirmationURL }}`; do not remove it.

## Privacy

Application code never logs email addresses, reset links or tokens. Reset emails are sent by Supabase, not by the KaamSetu server.

## Verifying after you configure it

1. Sign up with a real address and confirm the email arrives from your KaamSetu sender and the link lands on `/login`.
2. On `/login`, choose "Forgot your password?", request a link, open it: you should land on "Choose a new password".
3. Open the same link a second time: you should see "This reset link has expired or was already used."
4. Save a new password: you are sent to `/login` with a success message, and the new password works.
