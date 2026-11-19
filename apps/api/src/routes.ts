import express, { Router, type Response } from "express";
import { authenticate, getAuth, requireRole } from "./auth";
import { ApiError, mapDbError } from "./errors";
import { rankApplicants, type ApplicantRow } from "./fit";
import { createRateLimiter } from "./rateLimit";
import {
  aiDraftBody,
  aiWorkerDraftBody,
  applyBody,
  browseJobsQuery,
  cancelBody,
  contactBody,
  createJobBody,
  finishBookingBody,
  jobLocationBody,
  idParams,
  markReadBody,
  notificationsQuery,
  pageOnlyQuery,
  parse,
  profileUpdateBody,
  rejectBody,
  reviewBody,
  workerProfileBody,
} from "./schemas";
import type { Deps, JobRow, Reads, RpcName } from "./types";

/**
 * Calls a database function as the verified user. `p_actor` is spread LAST, so
 * nothing in `args` can override it; it always equals the id returned by
 * auth.getUser(jwt). Route handlers never read a user id from the request.
 */
async function callRpc(deps: Deps, res: Response, fn: RpcName, args: Record<string, unknown> = {}): Promise<unknown> {
  const { userId } = getAuth(res);
  const { data, error } = await deps.rpc(fn, { ...args, p_actor: userId });
  if (error) throw mapDbError(error);
  return data;
}

async function withEmployers(reads: Reads, jobs: JobRow[]) {
  const names = await reads.employerNames([...new Set(jobs.map((j) => j.employer_id))]);
  const byId = new Map(names.map((n) => [n.id, { full_name: n.full_name, org_name: n.org_name }]));
  return jobs.map((job) => ({ ...job, employer: byId.get(job.employer_id) ?? null }));
}

export function createApiRouter(deps: Deps): Router {
  const r = Router();
  const worker = requireRole("worker");
  const employer = requireRole("employer");
  const auth = authenticate(deps); // applied per route so unknown /api paths still return a JSON 404

  r.use(express.json({ limit: "32kb" }));

  // AI drafting costs money per call: cap each organiser at 12 drafts per 10 minutes.
  const aiLimiter = createRateLimiter({ max: 12, windowMs: 10 * 60_000 });

  // ------------------------------------------------------------------ profile
  r.get("/me", auth, async (_req, res) => {
    const { profile, reads, userId, role } = getAuth(res);
    if (role === "worker") {
      const wp = await reads.workerProfile(userId);
      res.json({ profile, worker: { ...wp.profile, category_ids: wp.category_ids } });
      return;
    }
    res.json({ profile, worker: null });
  });

  r.put("/me/profile", auth, async (req, res) => {
    const body = parse(profileUpdateBody, req.body);
    await callRpc(deps, res, "update_profile", {
      p_full_name: body.full_name,
      p_preferred_language: body.preferred_language,
      p_org_name: body.org_name ?? null,
    });
    const { reads, userId } = getAuth(res);
    res.json({ profile: await reads.profile(userId) });
  });

  r.put("/me/worker-profile", auth, worker, async (req, res) => {
    const body = parse(workerProfileBody, req.body);
    await callRpc(deps, res, "save_worker_profile", {
      p_bio: body.bio ?? null,
      p_years_experience: body.years_experience ?? null,
      p_locality_id: body.locality_id,
      p_is_available: body.is_available ?? true,
      p_category_ids: body.category_ids ?? null,
      p_skills: body.skills ?? null,
      p_availability_note: body.availability_note ?? null,
    });
    const { reads, userId } = getAuth(res);
    const wp = await reads.workerProfile(userId);
    res.json({ worker: { ...wp.profile, category_ids: wp.category_ids } });
  });

  // ------------------------------------------------------------------ contact phone (optional)
  r.get("/me/contact", auth, async (_req, res) => {
    const { reads, userId } = getAuth(res);
    res.json({ phone: (await reads.contact(userId))?.phone ?? null });
  });

  r.put("/me/contact", auth, async (req, res) => {
    const body = parse(contactBody, req.body);
    await callRpc(deps, res, "save_contact", { p_phone: body.phone });
    const { reads, userId } = getAuth(res);
    res.json({ phone: (await reads.contact(userId))?.phone ?? null });
  });

  // The other side's phone, only while the booking is live. Row-level security decides; we never read it with elevated rights.
  r.get("/bookings/:id/contact", auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { reads, userId } = getAuth(res);
    const booking = await reads.booking(id);
    if (!booking) throw new ApiError(404, "booking_not_found", "Booking not found.");
    const otherId = booking.worker_id === userId ? booking.employer_id : booking.worker_id;
    const live = booking.status === "confirmed" || booking.status === "in_progress";
    const [person, contact] = live ? await Promise.all([reads.profile(otherId), reads.contact(otherId)]) : [null, null];
    res.json({ name: person?.full_name ?? null, phone: contact?.phone ?? null, shared: live });
  });

  // ---------------------------------------------------------- reference data
  r.get("/categories", auth, async (_req, res) => {
    res.json({ categories: await getAuth(res).reads.categories() });
  });

  r.get("/localities", auth, async (_req, res) => {
    res.json({ localities: await getAuth(res).reads.localities() });
  });

  // ------------------------------------------------------------------ AI drafting
  // The AI only DRAFTS. Publishing is a separate explicit POST /api/jobs after the organiser confirms.
  r.get("/ai/status", auth, (_req, res) => {
    res.json({ available: Boolean(deps.ai) });
  });

  r.post("/ai/job-draft", auth, employer, async (req, res) => {
    const body = parse(aiDraftBody, req.body);
    if (!deps.ai) {
      throw new ApiError(503, "ai_not_configured", "AI job creation isn't set up on this server yet. You can still create the job with the form.");
    }
    const { reads, userId } = getAuth(res);
    aiLimiter.hit(userId);
    const [categories, localities] = await Promise.all([reads.categories(), reads.localities()]);
    const result = await deps.ai.draftJob(
      { text: body.text, answers: body.answers ?? [] },
      {
        categories: categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name_en, name_hi: c.name_hi, name_gu: c.name_gu })),
        language: getAuth(res).profile.preferred_language,
        localities: localities.map((l) => ({ id: l.id, name: l.name })),
        now: new Date(),
      },
    );
    res.json(result);
  });

  // A worker describes themselves in their own words; the AI drafts structured profile fields. Nothing is saved here:
  // the worker reviews and edits the draft and saves it through the ordinary PUT /api/me/worker-profile.
  r.post("/ai/worker-profile-draft", auth, worker, async (req, res) => {
    const body = parse(aiWorkerDraftBody, req.body);
    if (!deps.ai) {
      throw new ApiError(503, "ai_not_configured", "Describing yourself isn't set up on this server yet. You can still fill in the form yourself.");
    }
    const { reads, userId, profile } = getAuth(res);
    aiLimiter.hit(userId);
    const [categories, localities] = await Promise.all([reads.categories(), reads.localities()]);
    const result = await deps.ai.draftWorkerProfile(
      { text: body.text },
      {
        categories: categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name_en, name_hi: c.name_hi, name_gu: c.name_gu })),
        localities: localities.map((l) => ({ id: l.id, name: l.name })),
        language: profile.preferred_language,
      },
    );
    res.json(result);
  });

  // --------------------------------------------------------------------- jobs
  r.post("/jobs", auth, employer, async (req, res) => {
    const body = parse(createJobBody, req.body);
    const id = await callRpc(deps, res, "create_job", {
      p_category_id: body.category_id,
      p_locality_id: body.locality_id,
      p_title: body.title,
      p_description: body.description,
      p_starts_at: body.starts_at,
      p_ends_at: body.ends_at,
      p_workers_needed: body.workers_needed,
      p_pay_type: body.pay_type,
      p_pay_amount_paise: body.pay_amount_paise,
    });
    res.status(201).location(`/api/jobs/${String(id)}`).json({ id });
  });

  // Worker discovery: open, future jobs (RLS enforces the same; the filter keeps the result set tight).
  r.get("/jobs", auth, worker, async (req, res) => {
    const q = parse(browseJobsQuery, req.query);
    const jobs = await getAuth(res).reads.openJobs({
      localityId: q.locality_id,
      categoryId: q.category_id,
      q: q.q || undefined,
      dateFrom: q.date_from,
      dateTo: q.date_to,
      minHours: q.min_hours,
      maxHours: q.max_hours,
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ jobs: await withEmployers(getAuth(res).reads, jobs), page: { limit: q.limit, offset: q.offset } });
  });

  r.get("/employer/jobs", auth, employer, async (req, res) => {
    const q = parse(pageOnlyQuery, req.query);
    const { reads, userId } = getAuth(res);
    const jobs = await reads.employerJobs(userId, q);
    res.json({ jobs, page: { limit: q.limit, offset: q.offset } });
  });

  r.get("/jobs/:id", auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { reads, userId, role } = getAuth(res);
    const job = await reads.job(id); // RLS: owner, open+future for workers, or applicants/booked
    if (!job) {
      res.status(404).json({ error: { code: "job_not_found", message: "Job not found." } });
      return;
    }
    const [withEmployer] = await withEmployers(reads, [job]);
    const myApplication = role === "worker" ? await reads.applicationForJob(id, userId) : null;
    res.json({ job: withEmployer, my_application: myApplication });
  });

  // The exact address. Row-level security returns it only to the owning employer and to a worker with a live
  // booking on the job; everyone else (applicants included) gets `null`, exactly like "no address added".
  r.get("/jobs/:id/location", auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ location: await getAuth(res).reads.jobLocation(id) });
  });

  r.put("/jobs/:id/location", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(jobLocationBody, req.body);
    await callRpc(deps, res, "save_job_location", { p_job_id: id, p_address_line: body.address_line, p_landmark: body.landmark ?? null });
    res.json({ location: await getAuth(res).reads.jobLocation(id) });
  });

  r.post("/jobs/:id/cancel", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(cancelBody, req.body ?? {});
    await callRpc(deps, res, "cancel_job", { p_job_id: id, p_reason: body.reason ?? null });
    res.status(204).end();
  });

  // ------------------------------------------------------------- applications
  r.post("/jobs/:id/applications", auth, worker, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(applyBody, req.body ?? {});
    const applicationId = await callRpc(deps, res, "apply_to_job", { p_job_id: id, p_message: body.message ?? null });
    res.status(201).json({ application_id: applicationId });
  });

  r.get("/me/applications", auth, worker, async (req, res) => {
    const q = parse(pageOnlyQuery, req.query);
    const { reads, userId } = getAuth(res);
    const applications = await reads.workerApplications(userId, q);
    const jobs = await withEmployers(reads, await reads.jobsByIds([...new Set(applications.map((a) => a.job_id))]));
    const byId = new Map(jobs.map((j) => [j.id, j]));
    res.json({
      applications: applications.map((a) => ({ ...a, job: byId.get(a.job_id) ?? null })),
      page: { limit: q.limit, offset: q.offset },
    });
  });

  r.post("/applications/:id/withdraw", auth, worker, async (req, res) => {
    const { id } = parse(idParams, req.params);
    await callRpc(deps, res, "withdraw_application", { p_application_id: id });
    res.status(204).end();
  });

  // ------------------------------------------------- employer applicant mgmt
  // Evidence only: category match, locality match, years of experience. No score or rating.
  r.get("/jobs/:id/applicants", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const rows = (await callRpc(deps, res, "get_applicant_signals", { p_job_id: id })) as ApplicantRow[] | null;
    // Best fit first (facts only, missing data excluded not penalised); anyone with an overlapping booking last.
    res.json({ applicants: rankApplicants(rows ?? []) });
  });

  r.post("/applications/:id/accept", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const bookingId = await callRpc(deps, res, "accept_application", { p_application_id: id });
    res.status(201).json({ booking_id: bookingId });
  });

  r.post("/applications/:id/reject", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(rejectBody, req.body ?? {});
    await callRpc(deps, res, "reject_application", { p_application_id: id, p_reason: body.reason ?? null });
    res.status(204).end();
  });

  // ----------------------------------------------------------------- bookings
  r.get("/me/bookings", auth, async (req, res) => {
    const q = parse(pageOnlyQuery, req.query);
    const { reads } = getAuth(res);
    const bookings = await reads.bookings(q); // RLS: only bookings where the caller is the worker or employer
    const jobs = await withEmployers(reads, await reads.jobsByIds([...new Set(bookings.map((b) => b.job_id))]));
    const byId = new Map(jobs.map((j) => [j.id, j]));
    res.json({
      bookings: bookings.map((b) => ({ ...b, job: byId.get(b.job_id) ?? null })),
      page: { limit: q.limit, offset: q.offset },
    });
  });

  // Either party may cancel; the database decides who may cancel which state.
  r.post("/bookings/:id/cancel", auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(cancelBody, req.body ?? {});
    await callRpc(deps, res, "cancel_booking", { p_booking_id: id, p_reason: body.reason ?? null });
    res.status(204).end();
  });

  // The employer records what happened (only after the job has started); the database enforces the rules.
  r.post("/bookings/:id/finish", auth, employer, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(finishBookingBody, req.body);
    await callRpc(deps, res, "finish_booking", { p_booking_id: id, p_outcome: body.outcome });
    res.status(204).end();
  });

  // Either party of a completed booking rates the other once. The reviewee is derived from the booking, never supplied.
  r.post("/bookings/:id/review", auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(reviewBody, req.body);
    const reviewId = await callRpc(deps, res, "submit_review", { p_booking_id: id, p_rating: body.rating, p_comment: body.comment ?? null });
    res.status(201).json({ id: reviewId });
  });

  // Reviews the caller wrote or received (row-level security).
  r.get("/me/reviews", auth, async (_req, res) => {
    res.json({ reviews: await getAuth(res).reads.reviews() });
  });

  // ------------------------------------------------------------ notifications
  r.get("/notifications", auth, async (req, res) => {
    const q = parse(notificationsQuery, req.query);
    const notifications = await getAuth(res).reads.notifications({
      unreadOnly: q.unread === "true",
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ notifications, page: { limit: q.limit, offset: q.offset } });
  });

  r.post("/notifications/read", auth, async (req, res) => {
    const body = parse(markReadBody, req.body ?? {});
    const updated = await callRpc(deps, res, "mark_notifications_read", { p_ids: body.ids ?? null });
    res.json({ updated });
  });

  return r;
}
