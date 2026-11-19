import { useEffect, useState } from "react";
import { ApiError, api, type AiWorkerDraftResult } from "../lib/api";
import { useReference } from "../lib/reference";
import { VoiceInput } from "./VoiceInput";
import { Alert, Button, Card, ErrorAlert, TextAreaField } from "./ui";

const EXAMPLE = "I live in Gotri. I have loaded trucks for three years and I can lift heavy things. I'm free on weekends.";

/**
 * "Describe yourself": the worker says or types how they work, in English, Hindi, Gujarati or Hinglish, and the AI drafts
 * the profile fields. It only DRAFTS. Nothing is saved: the worker checks the draft here, applies it to the form,
 * edits anything, and saves with the normal Save button. Manual entry below is unchanged and always available.
 */
export function WorkerAiHelper({ onApply }: { onApply: (draft: AiWorkerDraftResult["draft"]) => void }) {
  const { categoryLabel, categories, localities } = useReference();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AiWorkerDraftResult | null>(null);

  useEffect(() => {
    let alive = true;
    api.aiStatus().then(
      (s) => alive && setAvailable(s.available),
      () => alive && setAvailable(true), // if the check itself fails, let them try: the real call explains
    );
    return () => {
      alive = false;
    };
  }, []);

  // When the AI isn't set up on this server, say nothing noisy: the manual form below is the way.
  if (available === false) return null;

  async function read() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.aiWorkerDraft({ text: text.trim() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const d = result?.draft;
  const placeName = d?.locality_id ? localities.find((l) => l.id === d.locality_id)?.name : null;
  const workNames = (d?.category_ids ?? []).map((id) => categories.find((c) => c.id === id)).filter(Boolean).map((c) => categoryLabel(c!));
  const aiDown = error instanceof ApiError && (error.code === "ai_unavailable" || error.code === "ai_not_configured" || error.code === "ai_busy");
  const nothing = d && !d.bio && d.years_experience === null && !d.locality_id && d.category_ids.length === 0 && d.skills.length === 0 && !d.availability_note;

  return (
    <Card className="border-l-4 border-l-terracotta bg-white">
      <h2 className="text-lg">Describe yourself</h2>
      <p className="text-sm text-ink-soft">
        Say or type, in your own words, where you live, what work you do, for how long and when you're free. Hindi, Gujarati and English all work. We'll fill in the form below,
        and you check everything before saving. We only use what you say.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <TextAreaField label="Tell us about your work" rows={4} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
        <VoiceInput label="Speak" disabled={busy} onText={(t) => setText((prev) => (prev.trim() ? `${prev.trim()} ${t}` : t))} />
        <div>
          <Button type="button" variant="secondary" loading={busy} disabled={text.trim().length < 10} onClick={() => void read()}>Read my description</Button>
          {text.trim().length > 0 && text.trim().length < 10 && <span className="ml-3 text-sm text-ink-soft">Write a little more.</span>}
        </div>
      </div>

      {error != null && (
        <div className="mt-3">
          <ErrorAlert error={error} />
          {aiDown && <p className="mt-2 text-sm text-ink-soft">You can still fill in the form below yourself.</p>}
        </div>
      )}

      {result && d && (
        <div role="group" aria-label="What I understood" className="mt-4 rounded-lg border-2 border-ink bg-white p-4">
          <h3 className="text-base">Here's what I understood</h3>
          {nothing ? (
            <p className="mt-2">I couldn't find details I can use in that. Try adding where you live and what work you do, or fill in the form below.</p>
          ) : (
            <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="font-semibold">Area</dt><dd>{placeName ?? <span className="text-ink-soft">Not mentioned</span>}</dd>
              <dt className="font-semibold">Work</dt><dd>{workNames.length ? workNames.join(", ") : <span className="text-ink-soft">Not mentioned</span>}</dd>
              <dt className="font-semibold">Experience</dt>
              <dd>{d.years_experience !== null ? `${d.years_experience} ${d.years_experience === 1 ? "year" : "years"}` : <span className="text-ink-soft">Not mentioned</span>}</dd>
              <dt className="font-semibold">Skills</dt><dd>{d.skills.length ? d.skills.join(", ") : <span className="text-ink-soft">Not mentioned</span>}</dd>
              <dt className="font-semibold">Available</dt><dd>{d.availability_note ?? <span className="text-ink-soft">Not mentioned</span>}</dd>
              <dt className="font-semibold">Introduction</dt><dd>{d.bio ?? <span className="text-ink-soft">Not mentioned</span>}</dd>
            </dl>
          )}

          {result.assumptions.length > 0 && (
            <Alert tone="warning" title="Please check these guesses" className="mt-3">
              <ul className="list-disc pl-5">
                {result.assumptions.map((a, i) => (
                  <li key={i}>{a.text}</li>
                ))}
              </ul>
            </Alert>
          )}
          {result.questions.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-semibold">Still missing (fill these in below):</p>
              <ul className="list-disc pl-5 text-sm text-ink-soft">
                {result.questions.map((q, i) => (
                  <li key={i}>{q.question}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-sm text-ink-soft">Anything you didn't mention stays as it is. Nothing is saved until you press “Save profile”.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {!nothing && <Button type="button" onClick={() => { onApply(d); setResult(null); }}>Fill my profile with this</Button>}
            <Button type="button" variant="secondary" onClick={() => setResult(null)}>{nothing ? "Close" : "Discard"}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
