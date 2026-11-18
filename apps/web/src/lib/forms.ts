import { ApiError } from "./api";

/** Maps the API's 422 `details` ([{ path, message }]) onto form fields keyed by the top-level path. */
export function serverFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.details) return {};
  const out: Record<string, string> = {};
  for (const d of err.details) {
    const key = d.path.split(".")[0] ?? "";
    if (key && !out[key]) out[key] = d.message;
  }
  return out;
}
