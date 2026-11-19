import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { JobCard, employerLabel } from "../components/JobCard";
import { VoiceInput } from "../components/VoiceInput";
import { Alert, Button, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, SelectField, TextField } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatRange, istDate } from "../lib/format";
import { useNotifications } from "../lib/notifications";
import { workerCompleteness } from "../lib/profile";
import { useReference } from "../lib/reference";
import { PAGE_SIZE, type Job } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { interpretJobQuery, type InterpretedQuery } from "../lib/voiceQuery";
import { CompletenessMeter } from "./WorkerProfile";

/** At-a-glance: how complete the profile is, what is booked, and where applications stand. */
function WorkerSummary() {
  const { me } = useAuth();
  const { version } = useNotifications();
  const bookings = useAsync(() => api.myBookings({ limit: 50 }), [version]);
  const applications = useAsync(() => api.myApplications({ limit: 50 }), [version]);
  const contact = useAsync(() => api.myContact(), []);

  if (!me) return null;
  const completeness = workerCompleteness(me, contact.data?.phone);
  const now = new Date();
  const upcoming = (bookings.data?.bookings ?? [])
    .filter((b) => (b.status === "confirmed" || b.status === "in_progress") && b.job && new Date(b.job.ends_at) > now)
    .sort((a, b) => Date.parse(a.job!.starts_at) - Date.parse(b.job!.starts_at));
  const apps = applications.data?.applications ?? [];
  const count = (s: string) => apps.filter((a) => a.status === s).length;

  return (
    <section aria-label="Your overview" className="mb-6 grid gap-4 lg:grid-cols-3">
      <CompletenessMeter percent={completeness.percent} missing={completeness.items.filter((i) => !i.done).slice(0, 2)} />

      <Card>
        <h2 className="text-lg">Your upcoming jobs</h2>
        {bookings.loading && !bookings.data ? (
          <p className="mt-2 text-ink-soft" role="status">Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="mt-2 text-ink-soft">No confirmed jobs yet. Apply to jobs below and you'll see them here once an employer books you.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {upcoming.slice(0, 3).map((b) => (
              <li key={b.id}>
                <Link to="/worker/bookings" className="font-semibold underline">{b.job!.title}</Link>
                <p className="text-sm text-ink-soft">{formatRange(b.job!.starts_at, b.job!.ends_at)}</p>
              </li>
            ))}
          </ul>
        )}
        {upcoming.length > 3 && <p className="mt-2 text-sm"><Link to="/worker/bookings" className="font-semibold underline">See all {upcoming.length} bookings</Link></p>}
      </Card>

      <Card>
        <h2 className="text-lg">Your applications</h2>
        {applications.loading && !applications.data ? (
          <p className="mt-2 text-ink-soft" role="status">Loading…</p>
        ) : apps.length === 0 ? (
          <p className="mt-2 text-ink-soft">You haven't applied yet. Find a job below and tap Apply.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            <li><strong>{count("pending")}</strong> waiting for the employer</li>
            <li><strong>{count("accepted")}</strong> accepted</li>
            <li><strong>{count("rejected")}</strong> not selected</li>
          </ul>
        )}
        <p className="mt-3 text-sm"><Link to="/worker/applications" className="font-semibold underline">See all applications</Link></p>
      </Card>
    </section>
  );
}

interface Interpretation {
  said: string;
  categoryId: string;
  localityId: string;
  date: string;
  keywords: string;
  summary: string;
  recognised: boolean;
}

export function WorkerJobs() {
  const { me } = useAuth();
  const { categories, localities } = useReference();
  const { version } = useNotifications();
  const myLocality = me?.worker?.locality_id ?? null;

  // Default to the worker's own area; they can widen to all of Vadodara.
  const [localityId, setLocalityId] = useState<string>(myLocality ? String(myLocality) : "");
  const [categoryId, setCategoryId] = useState<string>("");
  const [dateFilter, setDateFilter] = useState("");
  const [search, setSearch] = useState("");

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);
  // Bumped by "Show these jobs" so confirming always runs a fresh query, even when the
  // server-side filters (type of work, locality) happen to equal the current ones.
  const [searchRun, setSearchRun] = useState(0);
  const [searching, setSearching] = useState(false);

  // "Ask in your own words": spoken or typed, interpreted, shown back for the worker to edit and confirm.
  const [question, setQuestion] = useState("");
  const [reading, setReading] = useState<Interpretation | null>(null);

  const load = useCallback(
    async (offset: number, replace: boolean) => {
      const id = ++requestId.current;
      replace ? setLoading(true) : setLoadingMore(true);
      setError(null);
      try {
        const res = await api.browseJobs({
          limit: PAGE_SIZE,
          offset,
          locality_id: localityId ? Number(localityId) : undefined,
          category_id: categoryId ? Number(categoryId) : undefined,
        });
        if (id !== requestId.current) return;
        setJobs((prev) => (replace ? res.jobs : [...prev, ...res.jobs]));
        setHasMore(res.jobs.length === PAGE_SIZE);
      } catch (err) {
        if (id === requestId.current) {
          setError(err);
          if (replace) setJobs([]); // never leave results from an older search under a failed one
        }
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
          setSearching(false);
        }
      }
    },
    [localityId, categoryId],
  );

  useEffect(() => {
    void load(0, true);
  }, [load, version, searchRun]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (dateFilter && istDate(j.starts_at) !== dateFilter) return false;
      if (!q) return true;
      return `${j.title} ${j.description} ${employerLabel(j)}`.toLowerCase().includes(q);
    });
  }, [jobs, search, dateFilter]);

  const profileIncomplete = !me?.worker?.locality_id || (me?.worker?.category_ids.length ?? 0) === 0;
  const filtered = Boolean(localityId || categoryId || dateFilter || search.trim());

  function reset() {
    setLocalityId("");
    setCategoryId("");
    setDateFilter("");
    setSearch("");
  }

  function understand(text: string) {
    const q: InterpretedQuery = interpretJobQuery(text, { categories, localities });
    setReading({
      said: text,
      categoryId: q.categoryId ? String(q.categoryId) : "",
      localityId: q.localityId ? String(q.localityId) : "",
      date: q.date ?? "",
      keywords: q.keywords,
      summary: q.summary,
      recognised: q.recognised,
    });
  }

  function applyReading() {
    if (!reading) return;
    setCategoryId(reading.categoryId);
    setLocalityId(reading.localityId);
    setDateFilter(reading.date);
    setSearch(reading.keywords);
    setSearching(true); // hide the old list and show the loader until the new results arrive
    setSearchRun((n) => n + 1);
    setReading(null);
  }

  return (
    <>
      <PageHeader title="Find work" subtitle="Open jobs in Vadodara that are still looking for workers." />

      {profileIncomplete && (
        <Alert tone="warning" title="Finish your profile to apply" className="mb-5">
          Add your area and at least one kind of work you do.{" "}
          <Link to="/worker/profile" className="font-semibold underline">Complete your profile</Link>
        </Alert>
      )}

      <WorkerSummary />

      <Card className="mb-6">
        <h2 className="text-lg">Ask in your own words</h2>
        <p className="text-sm text-ink-soft">For example: “Show me event helper jobs near Alkapuri tomorrow.” Say it or type it, then check what I understood before searching.</p>
        <form
          role="search"
          aria-label="Ask for jobs in your own words"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) understand(question);
          }}
          className="mt-3 flex flex-col gap-3"
        >
          <TextField label="What are you looking for?" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Show me event helper jobs near Alkapuri tomorrow" />
          <VoiceInput label="Speak" onText={(t) => { setQuestion((q) => (q.trim() ? `${q.trim()} ${t}` : t)); }} />
          <div>
            <Button type="submit" variant="secondary" disabled={!question.trim()}>Understand my request</Button>
          </div>
        </form>

        {reading && (
          <div className="mt-4 rounded-lg border-2 border-ink bg-white p-4" role="group" aria-label="What I understood">
            <h3 className="text-base">Here's what I understood</h3>
            <p className="mt-1 text-sm text-ink-soft">You said: “{reading.said}”</p>
            <p className="mt-2 font-semibold" role="status">{reading.summary}</p>
            <p className="mt-1 text-sm text-ink-soft">Change anything that's not right, then search.</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SelectField label="Type of work" value={reading.categoryId} onChange={(e) => setReading({ ...reading, categoryId: e.target.value })}>
                <option value="">Any type of work</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name_en}</option>
                ))}
              </SelectField>
              <SelectField label="Locality" value={reading.localityId} onChange={(e) => setReading({ ...reading, localityId: e.target.value })}>
                <option value="">All of Vadodara</option>
                {localities.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </SelectField>
              <TextField label="Date" type="date" value={reading.date} onChange={(e) => setReading({ ...reading, date: e.target.value })} hint="Leave empty for any date." />
              <TextField label="Other words to look for" value={reading.keywords} onChange={(e) => setReading({ ...reading, keywords: e.target.value })} />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={applyReading}>Show these jobs</Button>
              <Button variant="secondary" onClick={() => setReading(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <form role="search" aria-label="Filter jobs" onSubmit={(e) => e.preventDefault()} className="mb-6 grid gap-4 rounded-xl border border-line bg-paper p-4 sm:grid-cols-2 lg:grid-cols-5">
        <TextField label="Search" type="search" placeholder="e.g. sofa, painting" hint="Searches the jobs shown below." value={search} onChange={(e) => setSearch(e.target.value)} />
        <SelectField label="Type of work" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All types of work</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name_en}</option>
          ))}
        </SelectField>
        <SelectField label="Locality" value={localityId} onChange={(e) => setLocalityId(e.target.value)}>
          <option value="">All of Vadodara</option>
          {localities.map((l) => (
            <option key={l.id} value={l.id}>{l.name}{l.id === myLocality ? " (my area)" : ""}</option>
          ))}
        </SelectField>
        <TextField label="Date" type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} hint="Empty = any date." />
        <div className="flex items-end">
          <Button variant="secondary" onClick={reset} disabled={!filtered} className="w-full">Clear filters</Button>
        </div>
      </form>

      {(loading && jobs.length === 0) || searching ? (
        <LoadingBlock label="Loading jobs…" />
      ) : error && jobs.length === 0 ? (
        <ErrorState error={error} onRetry={() => void load(0, true)} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={filtered ? "No jobs match your filters" : "No open jobs right now"}
          action={filtered ? <Button variant="secondary" onClick={reset}>Show all jobs</Button> : undefined}
        >
          {filtered ? "Try a different type of work, widen the locality, or clear the date." : "New jobs appear here as employers post them. Check back soon."}
        </EmptyState>
      ) : (
        <>
          <p className="sr-only" role="status">{visible.length} jobs shown</p>
          <ul className="flex flex-col gap-4">
            {visible.map((job) => (
              <li key={job.id}>
                <JobCard job={job} to={`/worker/jobs/${job.id}`} />
              </li>
            ))}
          </ul>
          {error != null && <ErrorState error={error} />}
          {hasMore && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" loading={loadingMore} onClick={() => void load(jobs.length, false)}>Load more jobs</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
