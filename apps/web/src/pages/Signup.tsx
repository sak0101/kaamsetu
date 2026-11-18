import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { homeFor } from "../components/Layout";
import { Alert, Button, TextField } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

const ROLE_OPTIONS: { value: Role; title: string; body: string }[] = [
  { value: "worker", title: "I'm looking for work", body: "Find nearby jobs and get booked." },
  { value: "employer", title: "I need workers", body: "Post jobs and book people for them." },
];

export function Signup() {
  const { status, me, signUp } = useAuth();
  const [params] = useSearchParams();
  const initialRole = params.get("role") === "employer" ? "employer" : params.get("role") === "worker" ? "worker" : null;
  const [role, setRole] = useState<Role | null>(initialRole);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ role?: string; fullName?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Sign up · KaamSetu";
  }, []);

  if (status === "signedIn" && me) return <Navigate to={homeFor(me.profile.role)} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!role) next.role = "Choose whether you're looking for work or need workers.";
    const name = fullName.trim();
    if (name.length < 2 || name.length > 80) next.fullName = "Enter your name (2 to 80 characters).";
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = "Enter a valid email address.";
    if (password.length < 8) next.password = "Use at least 8 characters.";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length || !role) return;

    setBusy(true);
    const result = await signUp({ email, password, fullName: name, role });
    setBusy(false);
    if (result.error) setFormError(result.error);
    else if (result.needsConfirmation) setConfirmEmail(email.trim());
  }

  if (confirmEmail) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Alert tone="success" title="Check your email">
          <p>
            We sent a confirmation link to <strong>{confirmEmail}</strong>. Open it to activate your account, then{" "}
            <Link to="/login" className="font-semibold underline">log in</Link>.
          </p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-3xl">Create your account</h1>
      <p className="mt-1 text-ink-soft">It takes a minute. We never ask for Aadhaar or ID numbers.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4 rounded-xl border border-line bg-paper p-5">
        {formError && <Alert tone="error">{formError}</Alert>}

        <fieldset className="flex flex-col gap-2" aria-describedby={errors.role ? "role-error" : undefined}>
          <legend className="mb-1 text-base font-semibold">
            I am… <span aria-hidden="true" className="text-danger">*</span>
          </legend>
          {ROLE_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border-2 p-3 ${role === o.value ? "border-ink bg-white" : "border-line bg-white/60"}`}
            >
              <input type="radio" name="role" value={o.value} checked={role === o.value} onChange={() => setRole(o.value)} className="mt-1 h-5 w-5 accent-terracotta-dark" />
              <span>
                <span className="block font-semibold">{o.title}</span>
                <span className="block text-sm text-ink-soft">{o.body}</span>
              </span>
            </label>
          ))}
          {errors.role && <p id="role-error" role="alert" className="text-sm font-semibold text-danger">{errors.role}</p>}
        </fieldset>

        <TextField label="Full name" autoComplete="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} />
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <Button type="submit" loading={busy}>Create account</Button>
      </form>
      <p className="mt-4 text-center text-ink-soft">
        Already registered? <Link to="/login" className="font-semibold text-ink underline">Log in</Link>
      </p>
    </div>
  );
}
