import type { ErrorRequestHandler } from "express";
import type { RpcError } from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

/** Human-readable text for the machine codes raised by the database functions. */
const MESSAGES: Record<string, string> = {
  unauthenticated: "Please sign in again.",
  account_suspended: "This account is suspended.",
  wrong_role: "Your account type cannot perform this action.",
  forbidden: "You are not allowed to do that.",
  job_not_found: "Job not found.",
  application_not_found: "Application not found.",
  booking_not_found: "Booking not found.",
  job_not_open: "This job is no longer open.",
  job_full: "This job already has all the workers it needs.",
  job_already_started: "This job has already started.",
  job_not_cancellable: "This job can no longer be cancelled.",
  already_applied: "You have already applied to this job.",
  too_many_pending: "You have too many pending applications. Withdraw one first.",
  worker_not_available: "Your profile is set to unavailable.",
  worker_profile_incomplete: "Add a locality and at least one work category before applying.",
  worker_double_booked: "This worker already has a booking that overlaps this time.",
  worker_unavailable: "This worker cannot be booked right now.",
  application_not_pending: "This application has already been decided.",
  booking_not_cancellable: "This booking can no longer be cancelled.",
  booking_already_ended: "This booking has already ended.",
  starts_at_must_be_future: "The start time must be in the future.",
  ends_at_must_follow_starts_at: "The end time must be after the start time.",
  invalid_category: "Unknown work category.",
  invalid_locality: "Unknown locality.",
  too_many_categories: "Choose at most 5 work categories.",
};

const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Translate a Postgres/PostgREST error into an HTTP error.
 * KS* SQLSTATEs come from our own functions (message = stable machine code).
 * Anything unrecognised becomes a generic 500: raw database text is never sent to clients.
 */
export function mapDbError(e: RpcError): ApiError {
  const code = e.code ?? "";
  const machine = MACHINE_CODE.test(e.message) ? e.message : "error";
  const text = MESSAGES[machine] ?? machine.replace(/_/g, " ");

  switch (code) {
    case "KS401":
      return new ApiError(401, machine, text);
    case "KS403":
      return new ApiError(403, machine, text);
    case "KS404":
      return new ApiError(404, machine, text);
    case "KS409":
      return new ApiError(409, machine, text);
    case "KS422":
      return new ApiError(422, machine, text);
    case "KS500":
      console.error("[kaamsetu] database refused: unsupported isolation level");
      return new ApiError(500, "server_misconfigured", "The server is misconfigured.");
    case "23514":
    case "23502":
      return new ApiError(422, "invalid_input", "One or more values are out of range.");
    case "23503":
      return new ApiError(422, "invalid_reference", "A referenced record does not exist.");
    case "23505":
      return new ApiError(409, "conflict", "That already exists.");
    case "42501":
      // Permission denied means our grants or keys are wrong. Not the caller's fault; never leak details.
      console.error("[kaamsetu] database permission denied (check grants / keys)");
      return new ApiError(500, "server_misconfigured", "The server is misconfigured.");
    default:
      break;
  }
  if (code.startsWith("22")) {
    return new ApiError(422, "invalid_input", "One or more values are invalid.");
  }
  if (code.startsWith("PGRST3")) {
    return new ApiError(401, "invalid_token", "Your session has expired. Please sign in again.");
  }
  console.error(`[kaamsetu] unexpected database error code=${code || "none"}`);
  return new ApiError(500, "internal_error", "Something went wrong.");
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  const type = (err as { type?: string } | undefined)?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON." } });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: { code: "payload_too_large", message: "Request body is too large." } });
    return;
  }

  // Unknown failure: log the type only; the message could contain anything.
  console.error(`[kaamsetu] unhandled error: ${(err as Error)?.name ?? "unknown"}`);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong." } });
};
