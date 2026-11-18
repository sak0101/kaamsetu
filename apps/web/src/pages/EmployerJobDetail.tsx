import { useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, ErrorState, Fact, LoadingBlock, TextAreaField } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatDate, formatPay, formatRange, relativeTime } from "../lib/format";
import { jobDisplay, type Tone } from "../lib/labels";
import { useNotifications } from "../lib/notifications";
import { useReference } from "../lib/reference";
import type { Applicant, Job } from "../lib/types";
import { useAsync } from "../lib/useAsync";

/** Employer-facing wording for an applicant's status. */
const EMPLOYER_STATUS: Record<Applicant["application_status"], { label: string; tone: Tone }> = {
  pending: { label: "Waiting for your decision", tone: "warning" },
  accepted: { label: "Booked", tone: "success" },
  rejected: { label: "Declined", tone: "danger" },
  withdrawn: { label: "Withdrew", tone: "neutral" },
};

const FIT_TONE: Record<Applicant["fit"]["label"], Tone> = {
  "Strong match": "success",
  "Good match": "info",
  "Partial match": "warning",
  "Weak match": "neutral",
};

function ApplicantCard({ applicant, onDecided }: { applicant: Applicant; onDecided: (message: string) => void }) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const pending = applicant.application_status === "pending";
  const status = EMPLOYER_STATUS[applicant.application_status];

  async function accept() {
    setBusy("accept");
    setError(null);
    try {
      await api.accept(applicant.application_id);
      onDecided(`${applicant.worker_name} is booked.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      await api.reject(applicant.application_id, reason.trim() || undefined);
      setRejecting(false);
      onDecided(`${applicant.worker_name}'s application was declined.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <article aria-label={`Applicant ${applicant.worker_name}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-lg">{applicant.worker_name}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={FIT_TONE[applicant.fit.label]}>{applicant.fit.label} · {applicant.fit.percent}%</Badge>
            {!pending && <Badge tone={status.tone}>{status.label}</Badge>}
          </div>
        </div>
        <p className="text-sm text-ink-soft">
          Applied {relativeTime(applicant.applied_at)} · On KaamSetu since {formatDate(applicant.member_since)}
        </p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="text-sm font-bold uppercase tracking-wide text-ink-soft">Why this match</h4>
            <ul className="mt-1 flex flex-col gap-1" aria-label={`Why ${applicant.worker_name} fits this job`}>
              {applicant.fit.reasons.map((r) => (
                <li key={r} className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-0.5 w-4 text-center font-bold text-success">✓</span>
                  <span>{r}</span>
                </li>
              ))}
              {applicant.fit.reasons.length === 0 && <li className="text-ink-soft">Nothing matches yet.</li>}
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-bold uppercase tracking-wide text-ink-soft">Worth knowing</h4>
            <ul className="mt-1 flex flex-col gap-1" aria-label={`Things to know about ${applicant.worker_name}`}>
              {applicant.fit.notes.map((n) => (
                <li key={n} className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-0.5 w-4 text-center font-bold text-ink-soft">–</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {applicant.bio && <p className="mt-3 text-ink-soft">{applicant.bio}</p>}
        {applicant.skills.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Skills">
            {applicant.skills.map((s) => (
              <li key={s} className="rounded-full border border-line bg-white px-3 py-0.5 text-sm font-semibold">{s}</li>
            ))}
          </ul>
        )}

        {applicant.has_booking_conflict && pending && (
          <Alert tone="warning" className="mt-3">
            Already confirmed for another job at an overlapping time, so they can't be booked for this one.
          </Alert>
        )}
        {applicant.message && <blockquote className="mt-3 border-l-4 border-marigold pl-3 text-ink-soft">“{applicant.message}”</blockquote>}

        {error != null && <ErrorAlert error={error} className="mt-3" />}

        {pending && (
          <div className="mt-4 flex flex-col gap-3">
            {!rejecting ? (
              <div className="flex flex-wrap gap-3">
                <Button loading={busy === "accept"} disabled={applicant.has_booking_conflict || busy !== null} onClick={() => void accept()}>
                  Accept and book
                </Button>
                <Button variant="secondary" disabled={busy !== null} onClick={() => setRejecting(true)}>Decline</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-line bg-white p-3">
                <TextAreaField label="Reason (optional)" hint="The worker will see this." maxLength={100} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex flex-wrap gap-3">
                  <Button variant="danger" loading={busy === "reject"} onClick={() => void reject()}>Decline applicant</Button>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => setRejecting(false)}>Keep applicant</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </article>
    </Card>
  );
}

function CancelJobPanel({ job, onDone }: { job: Job; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelJob(job.id, reason.trim() || undefined);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Cancel this job</Button>;
  return (
    <div className="flex flex-col gap-3 rounded-lg border-2 border-danger bg-white p-4">
      <p className="font-semibold">Cancel “{job.title}”?</p>
      <p className="text-ink-soft">Pending applications will be declined and any confirmed workers will be told the booking is cancelled.</p>
      {error != null && <ErrorAlert error={error} />}
      <TextAreaField label="Reason (optional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-3">
        <Button variant="danger" loading={busy} onClick={() => void cancel()}>Yes, cancel job</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Keep job</Button>
      </div>
    </div>
  );
}

export function EmployerJobDetail() {
  const { id = "" } = useParams();
  const location = useLocation();
  const { version } = useNotifications();
  const { categoryName, localityName } = useReference();
  const [notice, setNotice] = useState<string | null>((location.state as { created?: boolean } | null)?.created ? "Job posted. Workers can now apply." : null);

  const jobQ = useAsync(() => api.job(id), [id, version]);
  const applicantsQ = useAsync(() => api.applicants(id), [id, version]);

  const reloadAll = () => {
    jobQ.reload();
    applicantsQ.reload();
  };

  if (jobQ.loading && !jobQ.data) return <LoadingBlock label="Loading job…" rows={2} />;
  if (jobQ.error) {
    return jobQ.error instanceof ApiError && jobQ.error.status === 404 ? (
      <EmptyState title="Job not found" action={<Link to="/employer" className="font-semibold underline">Back to my jobs</Link>} />
    ) : (
      <ErrorState error={jobQ.error} onRetry={jobQ.reload} />
    );
  }
  if (!jobQ.data) return null;

  const job = jobQ.data.job;
  const status = jobDisplay(job);
  const ended = new Date(job.ends_at) <= new Date();
  const canCancel = job.status !== "cancelled" && !ended;
  const applicants = applicantsQ.data?.applicants ?? [];
  const pending = applicants.filter((a) => a.application_status === "pending");
  const decided = applicants.filter((a) => a.application_status !== "pending");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <p>
        <Link to="/employer" className="font-semibold underline">← My jobs</Link>
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl sm:text-3xl">{job.title}</h1>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Fact label="Type of work">{categoryName(job.category_id)}</Fact>
          <Fact label="Locality">{localityName(job.locality_id)}, Vadodara</Fact>
          <Fact label="When">{formatRange(job.starts_at, job.ends_at)}</Fact>
          <Fact label="Pay">{formatPay(job.pay_amount_paise, job.pay_type)}</Fact>
          <Fact label="Workers">{job.positions_filled} of {job.workers_needed} booked</Fact>
          {job.status === "cancelled" && <Fact label="Cancelled">{job.cancelled_reason ?? "Cancelled by you"}</Fact>}
        </dl>
        <p className="mt-4 whitespace-pre-wrap">{job.description}</p>
        {canCancel && <div className="mt-5"><CancelJobPanel job={job} onDone={() => { setNotice("Job cancelled."); reloadAll(); }} /></div>}
      </Card>

      <section aria-labelledby="applicants-h" className="flex flex-col gap-4">
        <div>
          <h2 id="applicants-h" className="text-xl">Applicants{applicants.length > 0 ? ` (${applicants.length})` : ""}</h2>
          <p className="text-sm text-ink-soft">
            Best match first. The match is worked out from three facts: type of work (most weight), locality and experience. Anything a worker hasn't shared is left
            out, never counted against them. There are no ratings or reviews yet, so new workers aren't disadvantaged. You make the final decision.
          </p>
        </div>

        {applicantsQ.loading && !applicantsQ.data ? (
          <LoadingBlock label="Loading applicants…" rows={2} />
        ) : applicantsQ.error ? (
          <ErrorState error={applicantsQ.error} onRetry={applicantsQ.reload} />
        ) : applicants.length === 0 ? (
          <EmptyState title="No applicants yet">Workers nearby can see your job now. You'll be notified when someone applies.</EmptyState>
        ) : (
          <>
            {pending.length > 0 && (
              <ul className="flex flex-col gap-4" aria-label="Waiting for your decision">
                {pending.map((a) => (
                  <li key={a.application_id}>
                    <ApplicantCard applicant={a} onDecided={(m) => { if (m) setNotice(m); reloadAll(); }} />
                  </li>
                ))}
              </ul>
            )}
            {decided.length > 0 && (
              <>
                <h3 className="mt-2 text-lg">Earlier decisions</h3>
                <ul className="flex flex-col gap-4">
                  {decided.map((a) => (
                    <li key={a.application_id}>
                      <ApplicantCard applicant={a} onDecided={() => reloadAll()} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
