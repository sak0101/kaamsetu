import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, Button, TextField } from "../components/ui";
import { useAuth } from "../lib/auth";

const NEW_LINK = (
  <Link to="/forgot-password" className="font-semibold underline">Request a new reset link</Link>
);

export function ResetPassword() {
  const { recovering, recoveryLinkError, completePasswordReset } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Choose a new password · KaamSetu";
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: typeof errors = {};
    if (password.length < 8) next.password = "Use at least 8 characters.";
    if (confirm !== password) next.confirm = "The two passwords don't match.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await completePasswordReset(password);
    setBusy(false);
    if (error) {
      setFormError(error);
      return;
    }
    navigate("/login", { replace: true, state: { notice: "Your password was updated. Log in with your new password." } });
  }

  if (!recovering) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-3xl">Reset your password</h1>
        <Alert tone={recoveryLinkError ? "error" : "info"} className="mt-6">
          <p>{recoveryLinkError ?? "Open the reset link from your email to choose a new password."}</p>
          <p className="mt-2">{NEW_LINK}</p>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-3xl">Choose a new password</h1>
      <p className="mt-1 text-ink-soft">Pick something at least 8 characters long that you don't use anywhere else.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4 rounded-xl border border-line bg-paper p-5">
        {formError && (
          <Alert tone="error">
            <p>{formError}</p>
            {/expired|already used/i.test(formError) && <p className="mt-2">{NEW_LINK}</p>}
          </Alert>
        )}
        <TextField label="New password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
        <Button type="submit" loading={busy}>Save new password</Button>
      </form>
    </div>
  );
}
