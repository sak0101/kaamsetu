import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { homeFor } from "../components/Layout";
import { Alert, Button, TextField } from "../components/ui";
import { useAuth } from "../lib/auth";

export function Login() {
  const { status, me, signIn } = useAuth();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Log in · KaamSetu";
  }, []);

  if (status === "signedIn" && me) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from.startsWith(`/${me.profile.role}`) ? from : homeFor(me.profile.role)} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = "Enter your email address.";
    if (!password) next.password = "Enter your password.";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) setFormError(error);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-3xl">Log in</h1>
      <p className="mt-1 text-ink-soft">Welcome back to KaamSetu.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4 rounded-xl border border-line bg-paper p-5">
        {notice && <Alert tone="success">{notice}</Alert>}
        {formError && <Alert tone="error">{formError}</Alert>}
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
        <Button type="submit" loading={busy}>Log in</Button>
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="font-semibold text-ink underline">Forgot your password?</Link>
        </p>
      </form>
      <p className="mt-4 text-center text-ink-soft">
        New to KaamSetu? <Link to="/signup" className="font-semibold text-ink underline">Create an account</Link>
      </p>
    </div>
  );
}
