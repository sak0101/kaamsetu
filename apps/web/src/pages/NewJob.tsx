import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, ButtonLink, ErrorAlert, PageHeader, SelectField, SourceBadge, TextAreaField, TextField } from "../components/ui";
import { api, type CreateJobInput } from "../lib/api";
import { serverFieldErrors } from "../lib/forms";
import { MAX_PAY_PAISE, formatInr, rupeesToPaise, toIstIso, todayIst } from "../lib/format";
import { useReference } from "../lib/reference";
import type { PayType } from "../lib/types";

export interface JobFormValues {
  categoryId: string;
  localityId: string;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  /** The work finishes after midnight, e.g. 5 PM to 12 AM. The end time is then on the following day. */
  endsNextDay: boolean;
  workers: string;
  payType: PayType | "";
  pay: string;
}

/** Draft field names (shared with the AI draft) that can carry a source badge. */
export type FlagField = "category" | "locality" | "title" | "description" | "date" | "start_time" | "end_time" | "workers_needed" | "pay_amount" | "pay_type";
export type FieldFlags = Partial<Record<FlagField, "ai" | "assumed" | "missing">>;

export const EMPTY_JOB: JobFormValues = {
  categoryId: "", localityId: "", title: "", description: "", date: "", startTime: "09:00", endTime: "13:00",
  endsNextDay: false, workers: "1", payType: "daily", pay: "",
};

/** YYYY-MM-DD plus one calendar day (pure date arithmetic, no timezone involved). */
export function addOneDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Validates the form and builds the exact API payload (times in IST, money in paise). */
export function buildJobPayload(v: JobFormValues, now: Date = new Date()): { payload?: CreateJobInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!v.categoryId) errors.category_id = "Choose the type of work.";
  if (!v.localityId) errors.locality_id = "Choose where the work is.";
  const title = v.title.trim();
  if (title.length < 5 || title.length > 100) errors.title = "Enter a short title (5 to 100 characters).";
  const description = v.description.trim();
  if (description.length < 1 || description.length > 1000) errors.description = "Describe the work (up to 1000 characters).";

  if (!v.date) errors.date = "Choose the date.";
  else if (v.date < todayIst(now)) errors.date = "The date can't be in the past.";
  if (!v.startTime) errors.starts_at = "Choose a start time.";
  if (!v.endTime) errors.ends_at = "Choose an end time.";

  let startsAt = "";
  let endsAt = "";
  if (v.date && v.startTime && v.endTime) {
    startsAt = toIstIso(v.date, v.startTime);
    endsAt = toIstIso(v.endsNextDay ? addOneDay(v.date) : v.date, v.endTime);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      errors.ends_at = v.endsNextDay
        ? "The end time must be after the start time."
        : "The end time must be after the start time. If the work ends after midnight, tick “Ends the next day”.";
    } else if (Date.parse(endsAt) - Date.parse(startsAt) > 14 * 86_400_000) errors.ends_at = "A job can last at most 14 days.";
    else if (Date.parse(startsAt) <= now.getTime() && !errors.date) errors.starts_at = "The start time must be in the future.";
  }

  const workers = Number(v.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 50) errors.workers_needed = "Enter between 1 and 50 workers.";

  if (!v.payType) errors.pay_type = "Choose how the pay works.";
  const paise = rupeesToPaise(v.pay);
  if (paise === null) errors.pay_amount_paise = "Enter the pay in rupees, for example 850 or 850.50.";
  else if (paise > MAX_PAY_PAISE) errors.pay_amount_paise = `The most you can offer is ${formatInr(MAX_PAY_PAISE)}.`;

  if (Object.keys(errors).length || !v.payType) return { errors };
  return {
    errors,
    payload: {
      category_id: Number(v.categoryId),
      locality_id: Number(v.localityId),
      title,
      description,
      starts_at: startsAt,
      ends_at: endsAt,
      workers_needed: workers,
      pay_type: v.payType,
      pay_amount_paise: paise!,
    },
  };
}

const PAY_LABEL: Record<PayType, string> = { daily: "per day", hourly: "per hour", fixed: "fixed price per worker" };

/**
 * The job editor, shared by the standard form and the AI review screen.
 * With `confirmLabel`, publishing is blocked until the organiser ticks an explicit confirmation.
 */
export function JobForm({
  initial,
  flags = {},
  submitLabel,
  confirmLabel,
  busy = false,
  formError = null,
  fieldErrors = {},
  onSubmit,
}: {
  initial: JobFormValues;
  flags?: FieldFlags;
  submitLabel: string;
  confirmLabel?: string;
  busy?: boolean;
  formError?: unknown;
  fieldErrors?: Record<string, string>;
  onSubmit: (payload: CreateJobInput) => void | Promise<void>;
}) {
  const { categories, localities, ready } = useReference();
  const [values, setValues] = useState<JobFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  const set = <K extends keyof JobFormValues>(key: K, value: JobFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const paise = rupeesToPaise(values.pay);
  const shown = { ...errors, ...fieldErrors };
  const badge = (f: FlagField) => (flags[f] ? <SourceBadge kind={flags[f]!} /> : undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setConfirmError("");
    const { payload, errors: found } = buildJobPayload(values);
    setErrors(found);
    if (confirmLabel && !confirmed) {
      setConfirmError("Please tick the box to confirm you've checked these details.");
      return;
    }
    if (!payload) return;
    await onSubmit(payload);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5 rounded-xl border border-line bg-paper p-5">
      {formError != null && <ErrorAlert error={formError} />}

      <TextField label="Job title" required maxLength={100} placeholder="e.g. Wedding helpers, Alkapuri" badge={badge("title")} value={values.title} onChange={(e) => set("title", e.target.value)} error={shown.title} />

      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField label="Type of work" required badge={badge("category")} value={values.categoryId} onChange={(e) => set("categoryId", e.target.value)} error={shown.category_id} disabled={!ready}>
          <option value="">Choose type of work</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name_en}</option>
          ))}
        </SelectField>
        <SelectField label="Locality in Vadodara" required badge={badge("locality")} value={values.localityId} onChange={(e) => set("localityId", e.target.value)} error={shown.locality_id} disabled={!ready}>
          <option value="">Choose a locality</option>
          {localities.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </SelectField>
      </div>

      <TextAreaField label="What needs to be done" required maxLength={1000} rows={5} hint="Duties, heavy items, tools needed, anything workers should know." badge={badge("description")} value={values.description} onChange={(e) => set("description", e.target.value)} error={shown.description} />

      <div className="grid gap-5 sm:grid-cols-3">
        <TextField label="Date" type="date" required min={todayIst()} badge={badge("date")} value={values.date} onChange={(e) => set("date", e.target.value)} error={shown.date} />
        <TextField label="Start time" type="time" required badge={badge("start_time")} value={values.startTime} onChange={(e) => set("startTime", e.target.value)} error={shown.starts_at} />
        <TextField label="End time" type="time" required badge={badge("end_time")} value={values.endTime} onChange={(e) => set("endTime", e.target.value)} error={shown.ends_at} />
      </div>
      <label className="-mt-2 flex min-h-11 cursor-pointer items-center gap-3">
        <input type="checkbox" checked={values.endsNextDay} onChange={(e) => set("endsNextDay", e.target.checked)} className="h-5 w-5 accent-terracotta-dark" />
        <span>
          <span className="font-semibold">Ends the next day</span>
          <span className="block text-sm text-ink-soft">Tick this if the work finishes after midnight (for example 5 PM to 12 AM).</span>
        </span>
      </label>

      <div className="grid gap-5 sm:grid-cols-3">
        <TextField label="Workers needed" type="number" inputMode="numeric" min={1} max={50} required badge={badge("workers_needed")} value={values.workers} onChange={(e) => set("workers", e.target.value)} error={shown.workers_needed} />
        <SelectField label="Pay is" required badge={badge("pay_type")} value={values.payType} onChange={(e) => set("payType", e.target.value as PayType | "")} error={shown.pay_type}>
          <option value="">Choose…</option>
          <option value="daily">Per day</option>
          <option value="hourly">Per hour</option>
          <option value="fixed">Fixed price per worker</option>
        </SelectField>
        <TextField label="Amount (₹)" inputMode="decimal" required placeholder="850" badge={badge("pay_amount")} value={values.pay} onChange={(e) => set("pay", e.target.value)} error={shown.pay_amount_paise} />
      </div>
      {paise !== null && paise <= MAX_PAY_PAISE && values.payType && (
        <p className="-mt-2 text-ink-soft" aria-live="polite">
          Workers will see: <strong>{formatInr(paise)} {PAY_LABEL[values.payType]}</strong>
        </p>
      )}

      {confirmLabel && (
        <div className="rounded-lg border-2 border-ink bg-white p-4">
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-describedby={confirmError ? "confirm-error" : undefined} className="mt-1 h-5 w-5 accent-terracotta-dark" />
            <span className="font-semibold">{confirmLabel}</span>
          </label>
          {confirmError && <p id="confirm-error" role="alert" className="mt-1 text-sm font-semibold text-danger">{confirmError}</p>}
        </div>
      )}

      <Button type="submit" loading={busy} disabled={Boolean(confirmLabel) && !confirmed}>{submitLabel}</Button>
    </form>
  );
}

export function NewJob() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function publish(payload: CreateJobInput) {
    setFormError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      const { id } = await api.createJob(payload);
      navigate(`/employer/jobs/${id}`, { state: { created: true } });
    } catch (err) {
      setFieldErrors(serverFieldErrors(err));
      setFormError(err);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <p className="mb-3">
        <Link to="/employer" className="font-semibold underline">← My jobs</Link>
      </p>
      <PageHeader title="Post a job" subtitle="Tell workers what you need. All times are Indian Standard Time (IST)." />

      <div className="mb-5 flex flex-col gap-3 rounded-xl border-2 border-terracotta bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-bold">Faster: just describe it.</p>
          <p className="text-ink-soft">Type or say what you need and AI drafts the job. You review everything before it's published.</p>
        </div>
        <ButtonLink to="/employer/jobs/new/ai">Create a job with AI</ButtonLink>
      </div>

      <JobForm initial={EMPTY_JOB} submitLabel="Post job" busy={busy} formError={formError} fieldErrors={fieldErrors} onSubmit={publish} />
    </div>
  );
}
