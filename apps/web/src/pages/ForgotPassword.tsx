import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, TextField } from "../components/ui";
import { useAuth } from "../lib/auth";

export function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Reset your password · KaamSetu";
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setFieldError("Enter the email address you signed up with.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    const { error } = await requestPasswordReset(email);
    setBusy(false);
    if (error) setFormError(error);
    else setSentTo(email.trim());
  }

  if (sentTo) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Alert tone="success" title="Check your email">
          <p>
            If there is a KaamSetu account for <strong>{sentTo}</strong>, we've sent a link to choose a new password. It can take a minute to arrive, and the link works only once.
          </p>
        </Alert>
        <p className="mt-4 text-center">
          <Link to="/login" className="font-semibold text-ink underline">Back to log in</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-3xl">Forgot your password?</h1>
      <p className="mt-1 text-ink-soft">Enter your email and we'll send you a link to choose a new one.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4 rounded-xl border border-line bg-paper p-5">
        {formError && <Alert tone="error">{formError}</Alert>}
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fieldError} />
        <Button type="submit" loading={busy}>Send reset link</Button>
      </form>
      <p className="mt-4 text-center text-ink-soft">
        Remembered it? <Link to="/login" className="font-semibold text-ink underline">Log in</Link>
      </p>
    </div>
  );
}
