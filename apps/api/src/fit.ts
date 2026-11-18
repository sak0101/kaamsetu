/**
 * Transparent "fit for this job" summary for an applicant.
 *
 * Deterministic and explainable: it uses only facts the worker provided plus
 * booking facts from the database. It is NOT a quality score and uses no AI.
 *
 * Fairness rules (enforced by tests):
 *  - Missing data (locality or experience not provided) is EXCLUDED and the
 *    remaining weights are renormalised; it is never treated as zero.
 *  - Reviews, attendance and reliability are not used because none exist yet.
 *    A worker with no history is never penalised for it.
 *  - An overlapping confirmed booking is a hard availability fact: it is flagged
 *    and sorts last, but it does not change the percentage.
 *  - The employer always makes the decision.
 */

export interface ApplicantRow {
  application_id: string;
  worker_id: string;
  worker_name: string;
  application_status: "pending" | "accepted" | "rejected" | "withdrawn";
  applied_at: string;
  message: string | null;
  category_match: boolean;
  locality_match: "same_locality" | "different_locality" | "unknown";
  years_experience: number | null;
  has_booking_conflict: boolean;
  bio: string | null;
  skills: string[];
  availability_note: string | null;
  member_since: string;
  completed_jobs: number;
}

export interface Fit {
  /** 0-100, from the signals that were available. */
  percent: number;
  label: "Strong match" | "Good match" | "Partial match" | "Weak match";
  /** Plain-language facts in the worker's favour. */
  reasons: string[];
  /** Plain-language cautions and things that were left out (never held against the worker). */
  notes: string[];
  signals_used: string[];
  signals_excluded: string[];
  has_conflict: boolean;
}

export const FIT_WEIGHTS = { category: 0.3, locality: 0.2, experience: 0.1 } as const;
const FULL_EXPERIENCE_YEARS = 5;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function computeFit(a: ApplicantRow): Fit {
  const reasons: string[] = [];
  const notes: string[] = [];
  const used: string[] = [];
  const excluded: string[] = [];
  let weighted = 0;
  let total = 0;
  const add = (name: keyof typeof FIT_WEIGHTS, score: number) => {
    weighted += FIT_WEIGHTS[name] * score;
    total += FIT_WEIGHTS[name];
    used.push(name);
  };

  // Type of work: always known.
  add("category", a.category_match ? 1 : 0);
  if (a.category_match) reasons.push("Offers this type of work");
  else notes.push("Doesn't list this type of work");

  // Locality: unknown is excluded, not penalised.
  if (a.locality_match === "unknown") {
    excluded.push("locality");
    notes.push("Locality not provided, so it isn't counted for or against them");
  } else {
    add("locality", a.locality_match === "same_locality" ? 1 : 0);
    if (a.locality_match === "same_locality") reasons.push("Works in this job's locality");
    else notes.push("Works in a different locality");
  }

  // Experience: unknown is excluded, an explicit 0 is real data.
  if (a.years_experience === null) {
    excluded.push("experience");
    notes.push("Experience not provided, so it isn't counted for or against them");
  } else {
    add("experience", Math.min(a.years_experience, FULL_EXPERIENCE_YEARS) / FULL_EXPERIENCE_YEARS);
    if (a.years_experience > 0) reasons.push(`${plural(a.years_experience, "year")} of experience`);
    else notes.push("Lists no prior experience");
  }

  // History on KaamSetu: shown as a fact, never scored.
  if (a.completed_jobs > 0) reasons.push(`Completed ${plural(a.completed_jobs, "job")} through KaamSetu`);
  else notes.push("New to KaamSetu: no completed jobs yet. This isn't held against them");
  excluded.push("reviews", "reliability");

  if (a.skills.length) reasons.push(`Skills: ${a.skills.join(", ")}`);
  if (a.availability_note) reasons.push(`Availability: ${a.availability_note}`);

  if (a.has_booking_conflict) notes.push("Already confirmed for another job at an overlapping time");

  const percent = total === 0 ? 0 : Math.round((weighted / total) * 100);
  const label: Fit["label"] = percent >= 80 ? "Strong match" : percent >= 55 ? "Good match" : percent >= 30 ? "Partial match" : "Weak match";
  return { percent, label, reasons, notes, signals_used: used, signals_excluded: excluded, has_conflict: a.has_booking_conflict };
}

export type RankedApplicant = ApplicantRow & { fit: Fit };

/** Best fit first. Anyone who can't be booked (overlap) goes last. Ties keep the order people applied. */
export function rankApplicants(rows: ApplicantRow[]): RankedApplicant[] {
  return rows
    .map((r) => ({ ...r, fit: computeFit(r) }))
    .sort(
      (x, y) =>
        Number(x.fit.has_conflict) - Number(y.fit.has_conflict) ||
        y.fit.percent - x.fit.percent ||
        Date.parse(x.applied_at) - Date.parse(y.applied_at) ||
        x.application_id.localeCompare(y.application_id),
    );
}
