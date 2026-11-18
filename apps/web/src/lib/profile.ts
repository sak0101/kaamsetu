import type { MeResponse } from "./types";

export interface CompletenessItem {
  key: string;
  label: string;
  done: boolean;
  /** Why it helps: shown next to anything still missing. */
  hint: string;
}

/**
 * How complete a worker's profile is. Every item is something the worker chose to
 * share; nothing here is verification, and Aadhaar or ID numbers are never part of it.
 */
export function workerCompleteness(me: MeResponse, phone: string | null | undefined): { percent: number; items: CompletenessItem[] } {
  const w = me.worker;
  const items: CompletenessItem[] = [
    { key: "locality", label: "Your area", done: Boolean(w?.locality_id), hint: "Needed to apply for jobs, and to show you nearby work." },
    { key: "categories", label: "Type of work you do", done: (w?.category_ids.length ?? 0) > 0, hint: "Needed to apply. Employers look for the right kind of work." },
    { key: "experience", label: "Years of experience", done: w?.years_experience != null, hint: "Optional. If left out it isn't counted against you." },
    { key: "bio", label: "A short introduction", done: Boolean(w?.bio?.trim()), hint: "Two lines about you help employers choose." },
    { key: "skills", label: "Skills", done: (w?.skills?.length ?? 0) > 0, hint: "For example guest handling, lifting, languages you speak." },
    { key: "availability", label: "When you're available", done: Boolean(w?.availability_note?.trim()), hint: "For example evenings and weekends." },
    { key: "phone", label: "Phone number", done: Boolean(phone), hint: "Optional. Only shared with an employer who has booked you." },
  ];
  return { percent: Math.round((items.filter((i) => i.done).length / items.length) * 100), items };
}

/** The two things required before a worker can apply. */
export const canApply = (me: MeResponse): boolean => Boolean(me.worker?.locality_id) && (me.worker?.category_ids.length ?? 0) > 0;
