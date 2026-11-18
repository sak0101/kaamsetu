import type { ApplicationStatus, Job, NotificationItem, Role } from "./types";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  confirmed: { label: "Confirmed", tone: "success" },
  in_progress: { label: "In progress", tone: "info" },
  completed: { label: "Completed", tone: "neutral" },
  cancelled_by_worker: { label: "Cancelled by worker", tone: "danger" },
  cancelled_by_employer: { label: "Cancelled by employer", tone: "danger" },
  cancelled_by_admin: { label: "Cancelled by KaamSetu", tone: "danger" },
  no_show: { label: "No-show", tone: "danger" },
};

export const APPLICATION_STATUS: Record<ApplicationStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for employer", tone: "warning" },
  accepted: { label: "Accepted: you're booked", tone: "success" },
  rejected: { label: "Not selected", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const known: Record<string, string> = {
    job_filled: "The job filled up.",
    job_cancelled: "The employer cancelled this job.",
    employer_rejected: "The employer chose other workers.",
  };
  return known[reason] ?? reason;
}

/** Derived from time + bookings (the database only stores open / filled / cancelled). */
export function jobDisplay(job: Job, now: Date = new Date()): { label: string; tone: Tone } {
  if (job.status === "cancelled") return { label: "Cancelled", tone: "danger" };
  if (new Date(job.ends_at) <= now) return { label: "Ended", tone: "neutral" };
  if (new Date(job.starts_at) <= now) {
    return job.positions_filled > 0 ? { label: "In progress", tone: "info" } : { label: "Expired", tone: "neutral" };
  }
  if (job.status === "filled") return { label: "Fully booked", tone: "success" };
  return { label: "Open", tone: "warning" };
}

/** Can a worker still apply to this job? */
export function isApplyable(job: Job, now: Date = new Date()): boolean {
  return job.status === "open" && new Date(job.starts_at) > now;
}

export function describeNotification(n: NotificationItem, role: Role): { text: string; to: string } {
  const title = n.payload.job_title ? `“${n.payload.job_title}”` : "a job";
  const home = role === "worker" ? "/worker" : "/employer";
  switch (n.type) {
    case "new_application":
      return { text: `New application for ${title}`, to: n.payload.job_id ? `/employer/jobs/${n.payload.job_id}` : "/employer" };
    case "application_rejected": {
      const why = reasonLabel(n.payload.reason);
      return { text: `Your application for ${title} wasn't selected${why ? `. ${why}` : "."}`, to: "/worker/applications" };
    }
    case "booking_confirmed":
      return { text: `You're booked for ${title}`, to: "/worker/bookings" };
    case "booking_cancelled": {
      const by = n.payload.cancelled_by;
      const who = by === "worker" ? "The worker" : by === "employer" ? "The employer" : by === "admin" ? "KaamSetu" : "Someone";
      return { text: `${who} cancelled the booking for ${title}`, to: `${home}/bookings` };
    }
    default:
      return { text: "You have a new notification", to: `${home}` };
  }
}
