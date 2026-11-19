import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { WorkerAiHelper } from "../components/WorkerAiHelper";
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, SourceBadge, TextAreaField, TextField } from "../components/ui";
import { ApiError, api, type AiWorkerDraftResult } from "../lib/api";
import { useAuth } from "../lib/auth";
import { serverFieldErrors } from "../lib/forms";
import { workerCompleteness } from "../lib/profile";
import { useReference } from "../lib/reference";

const MAX_CATEGORIES = 5;
const MAX_SKILLS = 8;
const SKILL_IDEAS = ["Guest handling", "Serving food", "Stage setup", "Heavy lifting", "Driving (two-wheeler)", "Gujarati", "Hindi", "English"];

export function CompletenessMeter({ percent, missing }: { percent: number; missing: { key: string; label: string; hint: string }[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg">Profile {percent}% complete</h2>
      </div>
      <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Profile completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full bg-terracotta-dark" style={{ width: `${percent}%` }} />
      </div>
      {missing.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {missing.map((m) => (
            <li key={m.key}>
              <span className="font-semibold">Add {m.label.toLowerCase()}.</span> <span className="text-ink-soft">{m.hint}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">Your profile is complete.</p>
      )}
    </Card>
  );
}

export function WorkerProfilePage() {
  const { me, reloadMe } = useAuth();
  const { categories, localities, ready, categoryLabel } = useReference();
  const worker = me?.worker;

  const [fullName, setFullName] = useState(me?.profile.full_name ?? "");
  const [language, setLanguage] = useState<"en" | "hi" | "gu">(me?.profile.preferred_language ?? "en");
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
  const [bio, setBio] = useState(worker?.bio ?? "");
  const [years, setYears] = useState(worker?.years_experience != null ? String(worker.years_experience) : "");
  const [localityId, setLocalityId] = useState(worker?.locality_id ? String(worker.locality_id) : "");
  const [categoryIds, setCategoryIds] = useState<number[]>(worker?.category_ids ?? []);
  const [skills, setSkills] = useState<string[]>(worker?.skills ?? []);
  const [skillDraft, setSkillDraft] = useState("");
  const [availabilityNote, setAvailabilityNote] = useState(worker?.availability_note ?? "");
  const [available, setAvailable] = useState(worker?.is_available ?? true);
  // Fields that were filled from the "Describe yourself" draft: they carry a "please check" badge until saved.
  const [aiFlags, setAiFlags] = useState<Set<string>>(new Set());
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

  /** Copies what the worker said into the editable form. Only fields the draft actually has are touched. */
  function applyAiDraft(d: AiWorkerDraftResult["draft"]) {
    const flags = new Set<string>();
    if (d.locality_id) { setLocalityId(String(d.locality_id)); flags.add("locality"); }
    if (d.category_ids.length) { setCategoryIds(d.category_ids.slice(0, MAX_CATEGORIES)); flags.add("categories"); }
    if (d.years_experience !== null) { setYears(String(d.years_experience)); flags.add("years"); }
    if (d.skills.length) {
      setSkills((prev) => [...prev, ...d.skills.filter((s) => !prev.some((x) => x.toLowerCase() === s.toLowerCase()))].slice(0, MAX_SKILLS));
      flags.add("skills");
    }
    if (d.availability_note) { setAvailabilityNote(d.availability_note.slice(0, 120)); flags.add("availability"); }
    if (d.bio) { setBio(d.bio.slice(0, 500)); flags.add("bio"); }
    if (d.is_available !== null) { setAvailable(d.is_available); flags.add("available"); }
    setAiFlags(flags);
    setSaved(false);
  }
  const ai = (key: string) => (aiFlags.has(key) ? <SourceBadge kind="ai" /> : undefined);

  function toggleCategory(id: number) {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : prev.length >= MAX_CATEGORIES ? prev : [...prev, id]));
  }

  function addSkill(raw: string) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (s.length < 2 || s.length > 40) {
      setErrors((e) => ({ ...e, skills: "A skill should be 2 to 40 characters." }));
      return;
    }
    if (skills.some((x) => x.toLowerCase() === s.toLowerCase())) {
      setSkillDraft("");
      return;
    }
    if (skills.length >= MAX_SKILLS) {
      setErrors((e) => ({ ...e, skills: `Add up to ${MAX_SKILLS} skills.` }));
      return;
    }
    setErrors((e) => {
      const { skills: _drop, ...rest } = e;
      return rest;
    });
    setSkills((prev) => [...prev, s]);
    setSkillDraft("");
  }

  function onSkillKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (skillDraft.trim()) addSkill(skillDraft);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setFormError(null);
    const next: Record<string, string> = {};
    const name = fullName.trim();
    if (name.length < 2 || name.length > 80) next.full_name = "Enter your name (2 to 80 characters).";
    let yearsValue: number | null = null;
    if (years.trim() !== "") {
      yearsValue = Number(years);
      if (!Number.isInteger(yearsValue) || yearsValue < 0 || yearsValue > 60) next.years_experience = "Enter whole years between 0 and 60, or leave it empty.";
    }
    if (!localityId) next.locality_id = "Choose the area you work in.";
    if (categoryIds.length === 0) next.category_ids = "Choose at least one kind of work.";
    if (bio.length > 500) next.bio = "Keep it under 500 characters.";
    if (availabilityNote.length > 120) next.availability_note = "Keep it under 120 characters.";
    const digits = phone.replace(/[\s().+-]/g, "");
    if (digits && !/^(91)?0?[6-9]\d{9}$/.test(digits) && !/^[6-9]\d{9}$/.test(digits)) next.phone = "Enter a 10-digit Indian mobile number, for example 98765 43210.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      if (name !== me?.profile.full_name || language !== (me?.profile.preferred_language ?? "en")) {
        await api.updateProfile({ full_name: name, preferred_language: language, org_name: null });
      }
      await api.saveWorkerProfile({
        bio: bio.trim() || null,
        years_experience: yearsValue,
        locality_id: Number(localityId),
        is_available: available,
        category_ids: categoryIds,
        skills,
        availability_note: availabilityNote.trim() || null,
      });
      if ((phone.trim() || null) !== (savedPhone ? savedPhone.replace(/^\+91/, "") : null)) {
        const res = await api.saveContact(phone.trim() || null);
        setSavedPhone(res.phone);
      }
      setAiFlags(new Set());
      await reloadMe();
      setSaved(true);
    } catch (err) {
      const fields = serverFieldErrors(err);
      if (err instanceof ApiError && err.code === "invalid_phone") fields.phone = "That doesn't look like an Indian mobile number.";
      if (err instanceof ApiError && err.code === "invalid_skills") fields.skills = "Check your skills: up to 8, each 2 to 40 characters.";
      setErrors(fields);
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  const completeness = me ? workerCompleteness({ ...me, worker: { category_ids: categoryIds, locality_id: localityId ? Number(localityId) : null, years_experience: years === "" ? null : Number(years), bio, skills, availability_note: availabilityNote } }, phone.trim() ? "set" : null) : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Your worker profile" subtitle="Employers see this when you apply. Share only what helps you get booked." />
      {completeness && (
        <div className="mb-5">
          <CompletenessMeter percent={completeness.percent} missing={completeness.items.filter((i) => !i.done)} />
        </div>
      )}
      <div className="mb-5">
        <WorkerAiHelper onApply={applyAiDraft} />
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5 rounded-xl border border-line bg-paper p-5">
        {aiFlags.size > 0 && <Alert tone="info" title="Filled from what you said">Check each marked box and change anything that isn't right. Nothing is saved until you press “Save profile”.</Alert>}
        {saved && <Alert tone="success">Profile saved.</Alert>}
        {formError != null && <ErrorAlert error={formError} />}

        <TextField label="Full name" required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.full_name} />
        <SelectField label="Language" hint="Used for work-type names and as the default for voice input. Hindi and Gujarati names are being reviewed by native speakers." value={language} onChange={(e) => setLanguage(e.target.value as "en" | "hi" | "gu")}>
          <option value="en">English</option>
          <option value="hi">हिन्दी (Hindi)</option>
          <option value="gu">ગુજરાતી (Gujarati)</option>
        </SelectField>

        <TextField
          label="Phone number (optional)"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="98765 43210"
          hint="Shared only with an employer who has booked you, and only while that booking is active. Never shown to other workers or on job listings."
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
        />

        <SelectField label="Area you work in" required badge={ai("locality")} value={localityId} onChange={(e) => setLocalityId(e.target.value)} error={errors.locality_id} disabled={!ready}>
          <option value="">Choose a locality</option>
          {localities.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </SelectField>

        <fieldset aria-describedby="cat-hint" className="flex flex-col gap-2">
          <legend className="text-base font-semibold">
            Work you do <span aria-hidden="true" className="text-danger">*</span> {ai("categories")}
          </legend>
          <p id="cat-hint" className="text-sm text-ink-soft">Choose up to {MAX_CATEGORIES}. ({categoryIds.length} selected)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {categories.map((c) => {
              const checked = categoryIds.includes(c.id);
              return (
                <label key={c.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border-2 px-3 ${checked ? "border-ink bg-white" : "border-line bg-white/60"}`}>
                  <input type="checkbox" checked={checked} disabled={!checked && categoryIds.length >= MAX_CATEGORIES} onChange={() => toggleCategory(c.id)} className="h-5 w-5 accent-terracotta-dark" />
                  {categoryLabel(c)}
                </label>
              );
            })}
          </div>
          {errors.category_ids && <p role="alert" className="text-sm font-semibold text-danger">{errors.category_ids}</p>}
        </fieldset>

        <TextField
          label="Years of experience"
          badge={ai("years")}
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          hint="Optional. If you leave it empty, employers will see “not provided”: it is never counted as zero."
          value={years}
          onChange={(e) => setYears(e.target.value)}
          error={errors.years_experience}
        />

        <fieldset className="flex flex-col gap-2" aria-describedby="skills-hint">
          <legend className="text-base font-semibold">Skills {ai("skills")}</legend>
          <p id="skills-hint" className="text-sm text-ink-soft">Up to {MAX_SKILLS}. Type a skill and press Enter, or tap a suggestion. ({skills.length} added)</p>
          {skills.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Your skills">
              {skills.map((s) => (
                <li key={s} className="inline-flex items-center gap-1 rounded-full border-2 border-ink bg-white py-1 pl-3 pr-1 font-semibold">
                  {s}
                  <button type="button" aria-label={`Remove skill ${s}`} onClick={() => setSkills((p) => p.filter((x) => x !== s))} className="flex h-11 w-11 items-center justify-center rounded-full text-lg leading-none hover:bg-cream">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              aria-label="Add a skill"
              className="min-h-11 w-full rounded-lg border-2 border-line bg-white px-3 py-2 text-base"
              maxLength={40}
              value={skillDraft}
              onChange={(e) => setSkillDraft(e.target.value)}
              onKeyDown={onSkillKey}
              placeholder="e.g. Guest handling"
            />
            <Button variant="secondary" onClick={() => skillDraft.trim() && addSkill(skillDraft)}>Add</Button>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Skill suggestions">
            {SKILL_IDEAS.filter((s) => !skills.some((x) => x.toLowerCase() === s.toLowerCase())).map((s) => (
              <button key={s} type="button" onClick={() => addSkill(s)} className="min-h-11 rounded-full border border-line bg-white px-3 text-sm hover:border-ink">
                + {s}
              </button>
            ))}
          </div>
          {errors.skills && <p role="alert" className="text-sm font-semibold text-danger">{errors.skills}</p>}
        </fieldset>

        <TextField label="When are you available?" badge={ai("availability")} maxLength={120} placeholder="e.g. Evenings and weekends" hint="Optional, shown to employers." value={availabilityNote} onChange={(e) => setAvailabilityNote(e.target.value)} error={errors.availability_note} />

        <TextAreaField label="About you (optional)" badge={ai("bio")} maxLength={500} hint="A few lines about your work and how you like to work." value={bio} onChange={(e) => setBio(e.target.value)} error={errors.bio} />

        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} className="h-5 w-5 accent-terracotta-dark" />
          <span>
            <span className="font-semibold">I'm available for new work {ai("available")}</span>
            <span className="block text-sm text-ink-soft">Turn this off to pause applications.</span>
          </span>
        </label>

        <p className="text-sm text-ink-soft">KaamSetu never asks for Aadhaar or any ID number.</p>
        <Button type="submit" loading={busy}>Save profile</Button>
      </form>
    </div>
  );
}
