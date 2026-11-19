import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, ErrorAlert, PageHeader, SelectField, TextField } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { serverFieldErrors } from "../lib/forms";

export function EmployerProfile() {
  const { me, reloadMe } = useAuth();
  const [fullName, setFullName] = useState(me?.profile.full_name ?? "");
  const [language, setLanguage] = useState<"en" | "hi" | "gu">(me?.profile.preferred_language ?? "en");
  const [orgName, setOrgName] = useState(me?.profile.org_name ?? "");
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // The number is only readable by its owner (row-level security), so load it for editing.
  useEffect(() => {
    let alive = true;
    api.myContact().then(
      ({ phone: p }) => {
        if (!alive) return;
        setSavedPhone(p);
        // Never overwrite what the user has already started typing while this request was in flight.
        setPhone((current) => (current === "" && p ? p.replace(/^\+91/, "") : current));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setFormError(null);
    const next: Record<string, string> = {};
    const name = fullName.trim();
    if (name.length < 2 || name.length > 80) next.full_name = "Enter your name (2 to 80 characters).";
    if (orgName.trim().length > 100) next.org_name = "Keep it under 100 characters.";
    const digits = phone.replace(/[\s().+-]/g, "");
    if (digits && !/^(91)?0?[6-9]\d{9}$/.test(digits) && !/^[6-9]\d{9}$/.test(digits)) next.phone = "Enter a 10-digit Indian mobile number, for example 98765 43210.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await api.updateProfile({ full_name: name, preferred_language: language, org_name: orgName.trim() || null });
      if ((phone.trim() || null) !== (savedPhone ? savedPhone.replace(/^\+91/, "") : null)) {
        const res = await api.saveContact(phone.trim() || null);
        setSavedPhone(res.phone);
      }
      await reloadMe();
      setSaved(true);
    } catch (err) {
      const fields = serverFieldErrors(err);
      if (err instanceof ApiError && err.code === "invalid_phone") fields.phone = "That doesn't look like an Indian mobile number.";
      setErrors(fields);
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Your profile" subtitle="Workers see this name on your jobs." />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5 rounded-xl border border-line bg-paper p-5">
        {saved && <Alert tone="success">Profile saved.</Alert>}
        {formError != null && <ErrorAlert error={formError} />}
        <TextField label="Your name" required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.full_name} />
        <SelectField label="Language" hint="Used for work-type names and as the default for voice input. Hindi and Gujarati names are being reviewed by native speakers." value={language} onChange={(e) => setLanguage(e.target.value as "en" | "hi" | "gu")}>
          <option value="en">English</option>
          <option value="hi">हिन्दी (Hindi)</option>
          <option value="gu">ગુજરાતી (Gujarati)</option>
        </SelectField>
        <TextField label="Business or organisation (optional)" autoComplete="organization" hint="Shown next to your name, e.g. “Shree Traders”." value={orgName} onChange={(e) => setOrgName(e.target.value)} error={errors.org_name} />
        <TextField
          label="Phone number (optional)"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          hint="Shared only with a worker you have booked, and only while that booking is active. Never shown on job listings or to other workers."
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
        />
        <Button type="submit" loading={busy}>Save profile</Button>
      </form>
    </div>
  );
}
