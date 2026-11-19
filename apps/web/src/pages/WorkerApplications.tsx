import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { JobCard } from "../components/JobCard";
import { Alert, Badge, Button, EmptyState, ErrorAlert, ErrorState, LoadingBlock, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { APPLICATION_STATUS, reasonLabel } from "../lib/labels";
import { useNotifications } from "../lib/notifications";
import { PAGE_SIZE, type Application } from "../lib/types";

export function WorkerApplications() {
  const { version } = useNotifications();
  const [items, setItems] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (offset: number, replace: boolean) => {
    const id = ++requestId.current;
    replace ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const res = await api.myApplications({ limit: PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      setItems((prev) => (replace ? res.applications : [...prev, ...res.applications]));
      setHasMore(res.applications.length === PAGE_SIZE);
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

  async function withdraw(app: Application) {
    setBusyId(app.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.withdraw(app.id);
      setNotice("Application withdrawn.");
      await load(0, true);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title="My applications" subtitle="Everything you've applied for, and what happened." />
      {notice && <Alert tone="success" className="mb-4">{notice}</Alert>}
      {actionError != null && <ErrorAlert error={actionError} className="mb-4" />}

      {loading && items.length === 0 ? (
        <LoadingBlock label="Loading applications…" />
      ) : error && items.length === 0 ? (
        <ErrorState error={error} onRetry={() => void load(0, true)} />
      ) : items.length === 0 ? (
        <EmptyState title="You haven't applied for any jobs yet" action={<Link to="/worker" className="inline-flex min-h-11 items-center rounded-lg bg-terracotta-dark px-4 font-semibold text-white hover:bg-terracotta-darker">Find work</Link>}>
          Browse open jobs and apply to the ones that suit you.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {items.map((app) => {
              const status = APPLICATION_STATUS[app.status];
              const reason = app.status === "rejected" ? reasonLabel(app.status_reason) : null;
              const footer = (
                <>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="text-sm text-ink-soft">Applied {relativeTime(app.created_at)}</span>
                  {reason && <span className="text-sm text-ink-soft">{reason}</span>}
                  {app.status === "pending" && (
                    <Button variant="secondary" loading={busyId === app.id} onClick={() => void withdraw(app)}>Withdraw</Button>
                  )}
                  {app.status === "accepted" && <Link to="/worker/bookings" className="inline-flex min-h-11 items-center font-semibold underline">View booking</Link>}
                </>
              );
              return (
                <li key={app.id}>
                  {app.job ? (
                    <JobCard job={app.job} to={`/worker/jobs/${app.job_id}`} footer={footer} />
                  ) : (
                    <div className="rounded-xl border border-line bg-paper p-4">
                      <p className="font-semibold">This job is no longer available.</p>
                      <div className="mt-3 flex flex-wrap items-center gap-3">{footer}</div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => void load(items.length, false)}>Load more</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
