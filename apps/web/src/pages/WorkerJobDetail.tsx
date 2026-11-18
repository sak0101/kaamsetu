import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { employerLabel } from "../components/JobCard";
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, ErrorState, Fact, LoadingBlock, TextAreaField } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatPay, formatRange } from "../lib/format";
import { APPLICATION_STATUS, isApplyable, jobDisplay, reasonLabel } from "../lib/labels";
import { useNotifications } from "../lib/notifications";
import { useReference } from "../lib/reference";
import type { Application, Job } from "../lib/types";
import { useAsync } from "../lib/useAsync";

function ApplicationPanel({ job, application, onChanged }: { job: Job; application: Application | null; onChanged: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await action();
      setDone(success);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const needsProfile = error instanceof ApiError && error.code === "worker_profile_incomplete";
  const status = application ? APPLICATION_STATUS[application.status] : null;
  const canApply = isApplyable(job) && (!application || application.status === "withdrawn");

  return (
    <Card>
      <h2 className="text-xl">Your application</h2>
      <div className="mt-3 flex flex-col gap-4">
        {done && <Alert tone="success">{done}</Alert>}
        {error != null && <ErrorAlert error={error} />}
        {needsProfile && (
          <p>
            <Link to="/worker/profile" className="font-semibold underline">Complete your profile</Link> and try again.
          </p>
        )}

        {status && application && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {application.status === "rejected" && reasonLabel(application.status_reason) && <span className="text-ink-soft">{reasonLabel(application.status_reason)}</span>}
          </div>
        )}

        {application?.status === "pending" && (
          <>
            {application.message && <p className="text-ink-soft">Your message: “{application.message}”</p>}
            <Button variant="secondary" loading={busy} onClick={() => void run(() => api.withdraw(application.id), "Application withdrawn.")}>
              Withdraw application
            </Button>
          </>
        )}

        {application?.status === "accepted" && (
          <p>
            Great news: the employer confirmed you. <Link to="/worker/bookings" className="font-semibold underline">See your bookings</Link>
          </p>
        )}

        {canApply && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.apply(job.id, message.trim() || undefined), "Application sent. You'll be notified when the employer decides.");
            }}
            className="flex flex-col gap-3"
          >
            <TextAreaField
              label="Message to the employer (optional)"
              hint="For example when you can start, or tools you bring."
              maxLength={300}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button type="submit" loading={busy}>{application?.status === "withdrawn" ? "Apply again" : "Apply for this job"}</Button>
          </form>
        )}

        {!application && !canApply && (
          <Alert tone="info">
            {job.status === "cancelled" ? "This job was cancelled." : job.status === "filled" ? "This job already has all the workers it needs." : "This job is no longer taking applications."}
          </Alert>
        )}
        {application?.status === "rejected" && <p className="text-ink-soft">You can't re-apply to a job after it was decided.</p>}
      </div>
    </Card>
  );
}

export function WorkerJobDetail() {
  const { id = "" } = useParams();
  const { version } = useNotifications();
  const { categoryName, localityName } = useReference();
  const { data, error, loading, reload } = useAsync(() => api.job(id), [id, version]);

  if (loading && !data) return <LoadingBlock label="Loading job…" rows={2} />;
  if (error) {
    return error instanceof ApiError && error.status === 404 ? (
      <EmptyState title="Job not found" action={<Link to="/worker" className="font-semibold underline">Back to all jobs</Link>}>
        It may have been filled, cancelled or removed.
      </EmptyState>
    ) : (
      <ErrorState error={error} onRetry={reload} />
    );
  }
  if (!data) return null;

  const { job, my_application } = data;
  const status = jobDisplay(job);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <p>
        <Link to="/worker" className="font-semibold underline">← All jobs</Link>
      </p>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-2xl sm:text-3xl">{job.title}</h1>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <p className="mt-1 text-ink-soft">Posted by {employerLabel(job)}</p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Fact label="Type of work">{categoryName(job.category_id)}</Fact>
          <Fact label="Locality">{localityName(job.locality_id)}, Vadodara</Fact>
          <Fact label="When">{formatRange(job.starts_at, job.ends_at)}</Fact>
          <Fact label="Pay">{formatPay(job.pay_amount_paise, job.pay_type)}</Fact>
          <Fact label="Workers">{job.positions_filled} of {job.workers_needed} booked</Fact>
        </dl>
        <h2 className="mt-5 text-lg">About this job</h2>
        <p className="mt-1 whitespace-pre-wrap">{job.description}</p>
      </Card>
      <ApplicationPanel job={job} application={my_application} onChanged={reload} />
    </div>
  );
}
