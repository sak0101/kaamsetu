import { ApiError } from "./errors";

/**
 * Small in-memory sliding-window limiter, used to cap AI spend per user.
 * NOTE: per process. GoDaddy runs one Node process per app, so this is exact there;
 * behind several instances each would count separately.
 */
export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number; code?: string; message?: string }) {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? Date.now;
  return {
    /** Records a hit, or throws 429 when the user is over the limit. */
    hit(key: string): void {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.max) {
        hits.set(key, recent);
        throw new ApiError(
          429,
          opts.code ?? "ai_rate_limited",
          opts.message ?? "You've used the AI assistant a lot in the last few minutes. Please wait a little, or use the form.",
        );
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (v.every((x) => t - x >= opts.windowMs)) hits.delete(k);
    },
  };
}
