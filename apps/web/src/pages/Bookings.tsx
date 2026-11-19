import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { JobCard } from "../components/JobCard";
import { Alert, Badge, Button, EmptyState, ErrorAlert, ErrorState, LoadingBlock, PageHeader, TextAreaField } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatInr } from "../lib/format";
import { BOOKING_STATUS } from "../lib/labels";
import { useNotifications } from "../lib/notifications";
import { PAGE_SIZE, type Booking, type Review, type Role } from "../lib/types";

/** Who may cancel which state. The database enforces the same rules; this only hides impossible buttons. */
export function canCancelBooking(b: Booking, role: Role, now: Date = new Date()): boolean {
  if (b.job && new Date(b.job.ends_at) <= now) return false;
  return role === "worker" ? b.status === "confirmed" : b.status === "confirmed" || b.status === "in_progress";
}

/** The employer records what happened, only once the job has started. The database enforces the same rule. */
export function canFinishBooking(b: Booking, role: Role, now: Date = new Date()): boolean {
  return role === "employer" && (b.status === "confirmed" || b.status === "in_progress") && Boolean(b.job) && new Date(b.job!.starts_at) <= now;
}

function FinishPanel({ booking, onDone }: { booking: Booking; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState<"completed" | "no_show" | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function finish(outcome: "completed" | "no_show") {
    setBusy(outcome);
    setError(null);
    try {
      await api.finishBooking(booking.id, outcome);
      onDone(outcome === "completed" ? "Marked as completed. You can now rate the worker." : "Marked as a no-show.");
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border-2 border-ink bg-white p-4">
      <p className="font-semibold">How did it go?</p>
      <p className="text-sm text-ink-soft">Record what happened. This can't be changed afterwards, and it helps you and other employers pick reliable workers.</p>
      {error != null && <ErrorAlert error={error} />}
      <div className="flex flex-wrap gap-3">
        <Button loading={busy === "completed"} disabled={busy !== null} onClick={() => void finish("completed")}>Work completed</Button>
        <Button variant="secondary" loading={busy === "no_show"} disabled={busy !== null} onClick={() => void finish("no_show")}>Didn't turn up</Button>
      </div>
    </div>
  );
}

/** One review per person per completed booking. Shows what you wrote and what they wrote about you. */
function ReviewPanel({ booking, role, reviews, onDone }: { booking: Booking; role: Role; reviews: Review[]; onDone: () => void }) {
  const { me } = useAuth();
  const mine = reviews.find((r) => r.booking_id === booking.id && r.reviewer_id === me?.profile.id);
  const theirs = reviews.find((r) => r.booking_id === booking.id && r.reviewee_id === me?.profile.id);
  const other = role === "worker" ? "employer" : "worker";
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ratingError, setRatingError] = useState("");

  async function submit() {
    if (rating < 1) {
      setRatingError("Choose a rating from 1 to 5.");
      return;
    }
    setRatingError("");
    setBusy(true);
    setError(null);
    try {
      await api.submitReview(booking.id, { rating, comment: comment.trim() || null });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {theirs && (
        <p className="text-sm">
          The {other} rated you <strong>{theirs.rating} out of 5</strong>
          {theirs.comment ? <>: “{theirs.comment}”</> : "."}
        </p>
      )}
      {mine ? (
        <p className="text-sm text-ink-soft" role="status">You rated the {other} <strong>{mine.rating} out of 5</strong>. Thank you.</p>
      ) : !open ? (
        <div><Button variant="secondary" onClick={() => setOpen(true)}>Rate the {other}</Button></div>
      ) : (
        <fieldset className="flex flex-col gap-3 rounded-lg border-2 border-ink bg-white p-4">
          <legend className="px-1 font-semibold">Rate the {other}</legend>
          <p className="text-sm text-ink-soft">Be honest and fair. You can only rate once, and it can't be changed.</p>
          {error != null && <ErrorAlert error={error} />}
          <div role="radiogroup" aria-label="Rating out of 5" className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className={`flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border-2 px-3 font-bold ${rating === n ? "border-ink bg-marigold" : "border-line bg-white"}`}>
                <input type="radio" name={`rating-${booking.id}`} value={n} aria-label={`${n} out of 5`} checked={rating === n} onChange={() => setRating(n)} className="sr-only" />
                <span aria-hidden="true">{n}</span>
              </label>
            ))}
          </div>
          {ratingError && <p role="alert" className="text-sm font-semibold text-danger">{ratingError}</p>}
          <TextAreaField label="Comment (optional)" maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-3">
            <Button loading={busy} onClick={() => void submit()}>Submit rating</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

function CancelPanel({ booking, role, onDone }: { booking: Booking; role: Role; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelBooking(booking.id, reason.trim() || undefined);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Cancel booking</Button>;
  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border-2 border-danger bg-white p-4">
      <p className="font-semibold">Cancel this booking?</p>
      <p className="text-ink-soft">{role === "worker" ? "The employer will be told straight away." : "The worker will be told straight away."}</p>
      {error != null && <ErrorAlert error={error} />}
      <TextAreaField label="Reason (optional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-3">
        <Button variant="danger" loading={busy} onClick={() => void cancel()}>Yes, cancel booking</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Keep booking</Button>
      </div>
    </div>
  );
}

/**
 * The other person's phone number, fetched only on request and only while the booking is live.
 * (The database enforces this too: the number is invisible once the booking ends.)
 */
function ContactPanel({ booking, role }: { booking: Booking; role: Role }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [contact, setContact] = useState<{ name: string | null; phone: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const other = role === "worker" ? "employer" : "worker";

  async function reveal() {
    setState("loading");
    setError(null);
    try {
      const c = await api.bookingContact(booking.id);
      setContact(c);
      setState("done");
    } catch (err) {
      setError(err);
      setState("idle");
    }
  }

  if (state !== "done") {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" loading={state === "loading"} onClick={() => void reveal()}>Show contact</Button>
        {error != null && <ErrorAlert error={error} />}
      </div>
    );
  }
  return (
    <p role="status" className="rounded-lg bg-white px-3 py-2">
      {contact?.phone ? (
        <>
          <span className="font-semibold">{contact.name ?? "Contact"}:</span>{" "}
          <a href={`tel:${contact.phone}`} className="font-bold underline">{contact.phone}</a>
        </>
      ) : (
        <>The {other} hasn't added a phone number yet. Use the notifications here to stay in touch.</>
      )}
    </p>
  );
}

export function BookingsPage({ role }: { role: Role }) {
  const { version } = useNotifications();
  const [items, setItems] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  // employer view: application_id -> worker name (from the applicants endpoint of each job)
  const [workerNames, setWorkerNames] = useState<Record<string, string>>({});
  const fetchedJobs = useRef(new Set<string>());
  const requestId = useRef(0);

  const load = useCallback(async (offset: number, replace: boolean) => {
    const id = ++requestId.current;
    replace ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const res = await api.myBookings({ limit: PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      setItems((prev) => (replace ? res.bookings : [...prev, ...res.bookings]));
      setHasMore(res.bookings.length === PAGE_SIZE);
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

  // Reviews you wrote or received (best effort: the page works without them).
  const loadReviews = useCallback(() => {
    api.myReviews().then(({ reviews: r }) => setReviews(r), () => {});
  }, []);
  useEffect(() => {
    loadReviews();
  }, [loadReviews, version]);

  // Employers: look up worker names through the applicants endpoint of each distinct job.
  useEffect(() => {
    if (role !== "employer") return;
    const jobIds = [...new Set(items.map((b) => b.job_id))].filter((j) => !fetchedJobs.current.has(j));
    jobIds.forEach((j) => fetchedJobs.current.add(j));
    jobIds.forEach((jobId) => {
      api.applicants(jobId).then(
        ({ applicants }) => setWorkerNames((prev) => ({ ...prev, ...Object.fromEntries(applicants.map((a) => [a.application_id, a.worker_name])) })),
        () => fetchedJobs.current.delete(jobId),
      );
    });
  }, [items, role]);

  const jobLink = (b: Booking) => (role === "worker" ? `/worker/jobs/${b.job_id}` : `/employer/jobs/${b.job_id}`);

  return (
    <>
      <PageHeader title="Bookings" subtitle={role === "worker" ? "Jobs you're confirmed for." : "Workers you've booked."} />
      {notice && <Alert tone="success" className="mb-4">{notice}</Alert>}

      {loading && items.length === 0 ? (
        <LoadingBlock label="Loading bookings…" />
      ) : error && items.length === 0 ? (
        <ErrorState error={error} onRetry={() => void load(0, true)} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          action={
            <Link to={role === "worker" ? "/worker" : "/employer"} className="inline-flex min-h-11 items-center rounded-lg bg-terracotta-dark px-4 font-semibold text-white hover:bg-terracotta-darker">
              {role === "worker" ? "Find work" : "See my jobs"}
            </Link>
          }
        >
          {role === "worker" ? "When an employer accepts your application, the booking shows up here." : "When you accept an applicant, the booking shows up here."}
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {items.map((b) => {
              const status = BOOKING_STATUS[b.status] ?? { label: b.status, tone: "neutral" as const };
              const footer = (
                <>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span className="font-semibold">{formatInr(b.agreed_pay_paise)} agreed</span>
                  {role === "employer" && <span>Worker: <strong>{workerNames[b.application_id] ?? "…"}</strong></span>}
                  {b.cancel_reason && <span className="text-sm text-ink-soft">Reason: {b.cancel_reason}</span>}
                  {(b.status === "confirmed" || b.status === "in_progress") && <ContactPanel booking={b} role={role} />}
                  {canFinishBooking(b, role) && (
                    <FinishPanel booking={b} onDone={(m) => { setNotice(m); void load(0, true); loadReviews(); }} />
                  )}
                  {b.status === "completed" && (
                    <ReviewPanel booking={b} role={role} reviews={reviews} onDone={() => { setNotice("Thank you. Your rating was saved."); loadReviews(); }} />
                  )}
                  {canCancelBooking(b, role) && (
                    <CancelPanel booking={b} role={role} onDone={() => { setNotice("Booking cancelled."); void load(0, true); }} />
                  )}
                </>
              );
              return (
                <li key={b.id}>
                  {b.job ? (
                    <JobCard job={b.job} to={jobLink(b)} showEmployer={role === "worker"} footer={footer} />
                  ) : (
                    <div className="rounded-xl border border-line bg-paper p-4">
                      <p className="font-semibold">Job details unavailable</p>
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
