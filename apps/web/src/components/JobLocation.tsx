import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { directionsUrl } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { JobLocation } from "../lib/types";
import { Button, ErrorAlert, TextField } from "./ui";

/** A plain "Get directions" link. It opens Google Maps on the worker's own device: no map key, no tracking. */
export function DirectionsLink({ location, localityName }: { location: JobLocation; localityName: string }) {
  return (
    <a
      href={directionsUrl(location.address_line, localityName)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-paper px-4 py-2 text-base font-semibold text-ink hover:bg-cream"
    >
      Get directions
      <span className="sr-only"> (opens Google Maps in a new tab)</span>
    </a>
  );
}

/**
 * Worker view. The exact address exists only once an employer has booked this worker (the database enforces it; for
 * everyone else the API simply returns nothing), so before that we say when it will be shared.
 */
export function WorkerLocationSection({ jobId, booked, localityName }: { jobId: string; booked: boolean; localityName: string }) {
  const q = useAsync(() => (booked ? api.jobLocation(jobId) : Promise.resolve({ location: null })), [jobId, booked]);

  if (!booked) {
    return (
      <p className="mt-4 rounded-lg bg-cream px-3 py-2 text-ink-soft">
        <span className="font-semibold text-ink">Exact address:</span> shared with you once the employer books you. Until then you can see the locality: {localityName}.
      </p>
    );
  }
  if (q.loading && !q.data) return <p className="mt-4 text-ink-soft" role="status">Loading the address…</p>;
  if (q.error) {
    return <p className="mt-4 text-ink-soft" role="status">We couldn't load the address just now. Please try again in a moment.</p>;
  }
  const location = q.data?.location ?? null;
  if (!location) {
    return (
      <p className="mt-4 rounded-lg bg-cream px-3 py-2 text-ink-soft">
        <span className="font-semibold text-ink">Exact address:</span> the employer hasn't added one yet, or this booking is no longer active. Check your Bookings page.
      </p>
    );
  }
  return (
    <section aria-label="Where to go" className="mt-4 rounded-lg border-2 border-ink bg-white p-4">
      <h2 className="text-lg">Where to go</h2>
      <p className="mt-1 font-semibold">{location.address_line}</p>
      <p className="text-ink-soft">{localityName}, Vadodara{location.landmark ? ` · Landmark: ${location.landmark}` : ""}</p>
      <div className="mt-3">
        <DirectionsLink location={location} localityName={localityName} />
      </div>
    </section>
  );
}

/** Employer view: see, add, change or clear the address of their own job. */
export function EmployerLocationPanel({ jobId, localityName, editable }: { jobId: string; localityName: string; editable: boolean }) {
  const q = useAsync(() => api.jobLocation(jobId), [jobId]);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [errors, setErrors] = useState<{ address?: string; landmark?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const location = q.data?.location ?? null;

  function startEditing() {
    setAddress(location?.address_line ?? "");
    setLandmark(location?.landmark ?? "");
    setErrors({});
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const a = address.trim();
    const l = landmark.trim();
    const next: typeof errors = {};
    if (a && (a.length < 5 || a.length > 200)) next.address = "Enter the address (5 to 200 characters), or leave it empty to remove it.";
    if (!a && l) next.address = "Add the address too, or clear the landmark.";
    if (l.length > 100) next.landmark = "Keep the landmark under 100 characters.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveJobLocation(jobId, { address_line: a, landmark: l || null });
      setEditing(false);
      q.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="loc-h" className="mt-5 rounded-lg border border-line bg-white p-4">
      <h2 id="loc-h" className="text-lg">Job address</h2>
      <p className="text-sm text-ink-soft">Only you and workers you have booked can see this. It is never shown in the public job list.</p>

      {q.loading && !q.data ? (
        <p className="mt-2 text-ink-soft" role="status">Loading…</p>
      ) : editing ? (
        <form onSubmit={save} noValidate className="mt-3 flex flex-col gap-4">
          {error != null && <ErrorAlert error={error} />}
          <TextField label="Address" autoComplete="off" maxLength={200} placeholder="e.g. 12 Race Course Circle" value={address} onChange={(e) => setAddress(e.target.value)} error={errors.address} />
          <TextField label="Landmark" autoComplete="off" maxLength={100} placeholder="e.g. Near the fountain" value={landmark} onChange={(e) => setLandmark(e.target.value)} error={errors.landmark} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={busy}>Save address</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : location ? (
        <div className="mt-2">
          <p className="font-semibold">{location.address_line}</p>
          <p className="text-ink-soft">{localityName}, Vadodara{location.landmark ? ` · Landmark: ${location.landmark}` : ""}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <DirectionsLink location={location} localityName={localityName} />
            {editable && <Button variant="secondary" onClick={startEditing}>Change address</Button>}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-ink-soft">No address added yet.</p>
          {editable && <Button variant="secondary" onClick={startEditing}>Add address</Button>}
        </div>
      )}
    </section>
  );
}
