import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { VoiceInput } from "../components/VoiceInput";
import { Alert, Button, Card, ErrorAlert, PageHeader, TextAreaField, TextField } from "../components/ui";
import { ApiError, api, type AiDraftResult, type CreateJobInput } from "../lib/api";
import { serverFieldErrors } from "../lib/forms";
import { useAsync } from "../lib/useAsync";
import { EMPTY_JOB, JobForm, type FieldFlags, type FlagField, type JobFormValues } from "./NewJob";

const EXAMPLES = [
  "I need 8 helpers for a wedding at a venue in Alkapuri, Vadodara tomorrow from 5 PM to midnight. Payment is ₹800 per person. They should help with guest coordination and basic arrangements.",
  "Two people to load and unload a tempo at Makarpura on Saturday morning, 8 AM to 12 noon, ₹600 each.",
  "Need 3 cleaners for a restaurant deep clean in Gotri this Sunday, 9 AM to 3 PM, ₹150 per hour.",
];

const rupees = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

/** Turns the AI draft into editable form values. Missing values stay empty: nothing is invented here. */
export function draftToForm(d: AiDraftResult["draft"]): JobFormValues {
  return {
    categoryId: d.category_id ? String(d.category_id) : "",
    localityId: d.locality_id ? String(d.locality_id) : "",
    title: d.title ?? "",
    description: d.description ?? "",
    date: d.date ?? "",
    startTime: d.start_time ?? "",
    endTime: d.end_time ?? "",
    endsNextDay: d.ends_next_day,
    workers: d.workers_needed ? String(d.workers_needed) : "",
    payType: d.pay_type ?? "",
    pay: d.pay_amount_paise ? rupees(d.pay_amount_paise) : "",
  };
}

const FIELD_ALIASES: [FlagField, RegExp][] = [
  ["pay_type", /pay.?type|per (day|hour|person|worker)|fixed|hourly|daily/i],
  ["pay_amount", /pay|wage|amount|rupee|₹/i],
  ["end_time", /end|midnight|overnight/i],
  ["start_time", /start/i],
  ["date", /date|day|tomorrow/i],
  ["workers_needed", /worker|people|helper|number/i],
  ["locality", /locality|area|location|venue/i],
  ["category", /categor|type of work/i],
  ["title", /title/i],
  ["description", /descri|responsib|requirement/i],
];

/** Which fields get which badge: missing, assumed (the model told us it inferred it), or filled by AI. */
export function draftFlags(r: AiDraftResult): FieldFlags {
  const flags: FieldFlags = {};
  const d = r.draft;
  const present: Record<FlagField, boolean> = {
    title: d.title !== null,
    category: d.category_id !== null,
    locality: d.locality_id !== null,
    description: d.description !== null,
    workers_needed: d.workers_needed !== null,
    date: d.date !== null,
    start_time: d.start_time !== null,
    end_time: d.end_time !== null,
    pay_amount: d.pay_amount_paise !== null,
    pay_type: d.pay_type !== null,
  };
  for (const f of Object.keys(present) as FlagField[]) flags[f] = present[f] ? "ai" : "missing";
  for (const a of r.assumptions) {
    const hit = FIELD_ALIASES.find(([, re]) => re.test(a.field))?.[0];
    if (hit && present[hit]) flags[hit] = "assumed";
  }
  return flags;
}

const AI_ERROR_HELP: Record<string, string> = {
  ai_not_configured: "AI job creation isn't set up on this server yet, but the standard form works fine.",
  ai_unavailable: "The AI assistant isn't reachable right now. Try again in a moment, or use the standard form.",
  ai_busy: "The AI assistant is busy. Try again in a minute, or use the standard form.",
  ai_rate_limited: "You've used the assistant a lot just now. Wait a few minutes, or use the standard form.",
  ai_invalid_response: "The assistant's answer couldn't be read. Try again, or use the standard form.",
  ai_declined: "The assistant couldn't help with that wording. Rephrase it, or use the standard form.",
};

export function NewJobAi() {
  const navigate = useNavigate();
  const status = useAsync(() => api.aiStatus(), []);
  const [text, setText] = useState("");
  const [result, setResult] = useState<AiDraftResult | null>(null);
  const [version, setVersion] = useState(0);
  const [answered, setAnswered] = useState<{ question: string; answer: string }[]>([]);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<unknown>(null);
  const [publishFieldErrors, setPublishFieldErrors] = useState<Record<string, string>>({});

  const available = status.data?.available;

  function appendVoice(spoken: string) {
    if (spoken) setText((t) => (t.trim() ? `${t.trim()} ${spoken}` : spoken));
  }

  async function createDraft(answers: { question: string; answer: string }[]) {
    setDrafting(true);
    setDraftError(null);
    try {
      const r = await api.aiJobDraft({ text: text.trim(), ...(answers.length ? { answers } : {}) });
      setResult(r);
      setAnswered(answers);
      setPending({});
      setVersion((v) => v + 1);
    } catch (err) {
      setDraftError(err);
    } finally {
      setDrafting(false);
    }
  }

  async function updateWithAnswers() {
    if (!result) return;
    const fresh = result.questions
      .map((q) => ({ question: q.question, answer: (pending[q.question] ?? "").trim() }))
      .filter((a) => a.answer);
    await createDraft([...answered, ...fresh]);
  }

  async function publish(payload: CreateJobInput) {
    setPublishing(true);
    setPublishError(null);
    setPublishFieldErrors({});
    try {
      const { id } = await api.createJob(payload); // the ONLY place a job is created, and only after the confirmation tick
      navigate(`/employer/jobs/${id}`, { state: { created: true } });
    } catch (err) {
      setPublishError(err);
      setPublishFieldErrors(serverFieldErrors(err));
      setPublishing(false);
    }
  }

  const draftErrorCode = draftError instanceof ApiError ? draftError.code : "";
  const anyAnswer = result ? result.questions.some((q) => (pending[q.question] ?? "").trim()) : false;

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-3">
        <Link to="/employer" className="font-semibold underline">← My jobs</Link>
      </p>
      <PageHeader
        title="Create a job with AI"
        subtitle="Describe the work in your own words. AI drafts the job, you check and edit it, and nothing is published until you confirm."
      />

      {status.data && !available && (
        <Alert tone="warning" title="AI job creation isn't switched on here" className="mb-5">
          This server has no AI key configured, so the assistant can't draft jobs. You can still{" "}
          <Link to="/employer/jobs/new" className="font-semibold underline">use the standard form</Link>.
        </Alert>
      )}

      {!result ? (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createDraft([]);
            }}
            className="flex flex-col gap-4"
          >
            {draftError != null && (
              <div className="flex flex-col gap-2">
                <ErrorAlert error={draftError} />
                {AI_ERROR_HELP[draftErrorCode] && <p className="text-ink-soft">{AI_ERROR_HELP[draftErrorCode]}</p>}
              </div>
            )}
            <TextAreaField
              label="Describe the job"
              required
              rows={6}
              maxLength={1500}
              hint="Say what the work is, where in Vadodara, when, how many people and what you'll pay. You can type, or press Speak and say it."
              placeholder="e.g. I need 8 helpers for a wedding in Alkapuri tomorrow, 5 PM to midnight, ₹800 each…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <VoiceInput onText={appendVoice} label="Speak" disabled={drafting} />
            <p className="text-sm text-ink-soft">What you say appears in the box above first. Edit it if needed, then create the draft.</p>

            <div>
              <p className="mb-2 text-sm font-semibold">Try an example</p>
              <ul className="flex flex-col gap-2">
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button type="button" onClick={() => setText(ex)} className="min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-left text-sm hover:border-ink">
                      {ex}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={drafting} disabled={text.trim().length < 10 || available === false}>
                {drafting ? "Reading your request…" : "Create draft"}
              </Button>
              <Link to="/employer/jobs/new" className="font-semibold underline">Prefer the standard form?</Link>
            </div>
          </form>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <Alert tone="info" title="Your draft is ready to check">
            <p>Nothing is published yet. Review every detail, change anything that's wrong, then confirm at the bottom.</p>
          </Alert>

          {result.questions.length > 0 && (
            <Card className="border-danger">
              <h2 className="text-xl">A few details are missing or unclear</h2>
              <p className="mt-1 text-ink-soft">I didn't guess these. Answer here, or fill the matching fields below.</p>
              {draftError != null && <ErrorAlert error={draftError} className="mt-3" />}
              <ul className="mt-4 flex flex-col gap-4">
                {result.questions.map((q) => (
                  <li key={q.question}>
                    <TextField
                      label={q.question}
                      value={pending[q.question] ?? ""}
                      onChange={(e) => setPending((p) => ({ ...p, [q.question]: e.target.value }))}
                    />
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button loading={drafting} disabled={!anyAnswer} onClick={() => void updateWithAnswers()}>Update draft</Button>
                <span className="text-sm text-ink-soft">Updating redraws the form below and replaces any edits you made there.</span>
              </div>
            </Card>
          )}

          {result.assumptions.length > 0 && (
            <Card className="border-marigold">
              <h2 className="text-xl">What I assumed: please check</h2>
              <ul className="mt-2 list-disc pl-5">
                {result.assumptions.map((a, i) => (
                  <li key={`${a.field}-${i}`}>{a.text}</li>
                ))}
              </ul>
            </Card>
          )}

          <JobForm
            key={version}
            initial={{ ...EMPTY_JOB, ...draftToForm(result.draft) }}
            flags={draftFlags(result)}
            submitLabel="Publish job"
            confirmLabel="I've checked these details and I want to publish this job."
            busy={publishing}
            formError={publishError}
            fieldErrors={publishFieldErrors}
            onSubmit={publish}
          />

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => { setResult(null); setAnswered([]); setPending({}); }}>Edit my description</Button>
            <Link to="/employer/jobs/new" className="inline-flex min-h-11 items-center font-semibold underline">Use the standard form instead</Link>
          </div>
        </div>
      )}
    </div>
  );
}
