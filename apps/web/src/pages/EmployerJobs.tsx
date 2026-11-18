import { useCallback, useEffect, useRef, useState } from "react";
import { JobCard } from "../components/JobCard";
import { Badge, Button, ButtonLink, EmptyState, ErrorState, LoadingBlock, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { useNotifications } from "../lib/notifications";
import { PAGE_SIZE, type Job } from "../lib/types";
import { useAsync } from "../lib/useAsync";

/**
 * Application counts come from GET /api/jobs/:id/applicants (there is no
 * dedicated count endpoint), fetched per card.
 */
function ApplicantCount({ job }: { job: Job }) {
  const { version } = useNotifications();
  const { data, error } = useAsync(() => api.applicants(job.id), [job.id, version]);
  if (error) return <span className="text-sm text-ink-soft">Applicants unavailable</span>;
  if (!data) return <span className="text-sm text-ink-soft" aria-busy="true">Counting applicants…</span>;
  const pending = data.applicants.filter((a) => a.application_status === "pending").length;
  const total = data.applicants.length;
  return pending > 0 ? (
    <Badge tone="warning">{pending} waiting for your decision</Badge>
  ) : (
    <span className="text-sm text-ink-soft">{total === 0 ? "No applicants yet" : `${total} applicant${total === 1 ? "" : "s"}, none waiting`}</span>
  );
}

export function EmployerJobs() {
  const { version } = useNotifications();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const load = useCallback(async (offset: number, replace: boolean) => {
    const id = ++requestId.current;
    replace ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const res = await api.employerJobs({ limit: PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      setJobs((prev) => (replace ? res.jobs : [...prev, ...res.jobs]));
      setHasMore(res.jobs.length === PAGE_SIZE);
    } catch (err) {
      if (id === requestId.current) setError(err);
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(0, true);
  }, [load, version]);

  return (
    <>
      <PageHeader title="My jobs" subtitle="Jobs you've posted and the people who applied." actions={
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/employer/jobs/new/ai">Create a job with AI</ButtonLink>
            <ButtonLink to="/employer/jobs/new" variant="secondary">Post with the form</ButtonLink>
          </div>
        } />

      {loading && jobs.length === 0 ? (
        <LoadingBlock label="Loading your jobs…" />
      ) : error && jobs.length === 0 ? (
        <ErrorState error={error} onRetry={() => void load(0, true)} />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="You haven't posted any jobs yet"
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <ButtonLink to="/employer/jobs/new/ai">Create a job with AI</ButtonLink>
              <ButtonLink to="/employer/jobs/new" variant="secondary">Post your first job</ButtonLink>
            </div>
          }
        >
          Describe the work, pick the day and pay, and nearby workers can apply.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {jobs.map((job) => (
              <li key={job.id}>
                <JobCard
                  job={job}
                  to={`/employer/jobs/${job.id}`}
                  showEmployer={false}
                  footer={
                    <>
                      {job.status !== "cancelled" && <ApplicantCount job={job} />}
                      <ButtonLink to={`/employer/jobs/${job.id}`} variant="secondary">Manage</ButtonLink>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => void load(jobs.length, false)}>Load more</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
