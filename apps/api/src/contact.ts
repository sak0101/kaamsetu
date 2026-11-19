import express, { Router } from "express";
import { z } from "zod";
import { ApiError } from "./errors";
import type { ContactMailer } from "./mailer";
import { createRateLimiter } from "./rateLimit";
import { parse } from "./schemas";

export const contactBody = z
  .object({
    name: z.string().trim().min(2, "Enter your name.").max(80),
    email: z.string().trim().max(120).pipe(z.email("Enter a valid email address.")),
    message: z.string().trim().min(10, "Write a few words so we can help.").max(2000, "Please keep it under 2000 characters."),
    /** Honeypot: hidden from people. Bots fill it in. */
    website: z.string().max(200).optional(),
  })
  .strict();

/**
 * Public contact form. Independent of Supabase: it is mounted whether or not the data API is configured.
 * Abuse controls: strict schema, small body limit, honeypot, per-client and global hourly caps.
 * Message contents, names and addresses are never logged.
 */
export function createContactRouter(mailer: ContactMailer | null, opts: { demo?: boolean } = {}): Router {
  const r = Router();
  r.use(express.json({ limit: "8kb" }));

  const perClient = createRateLimiter({
    max: 5,
    windowMs: 60 * 60_000,
    code: "contact_rate_limited",
    message: "You've sent several messages recently. Please wait a while, or email us directly.",
  });
  const everyone = createRateLimiter({
    max: 60,
    windowMs: 60 * 60_000,
    code: "contact_rate_limited",
    message: "We're getting a lot of messages right now. Please email us directly instead.",
  });

  r.post("/", async (req, res) => {
    const body = parse(contactBody, req.body);

    // A filled honeypot is a bot. Answer exactly like a success so it learns nothing; send nothing.
    if (body.website && body.website.trim() !== "") {
      res.status(202).json({ ok: true });
      return;
    }

    // Demo mode (explicit opt-in via CONTACT_DEMO_MODE=true): nothing is sent or stored, and the response says so
    // (`demo: true`) so the page can label it. Real delivery and its errors are unchanged when the switch is off.
    if (opts.demo) {
      perClient.hit(req.ip ?? "unknown");
      everyone.hit("all");
      res.status(202).json({ ok: true, demo: true });
      return;
    }

    if (!mailer) {
      throw new ApiError(503, "contact_not_configured", "The contact form isn't available right now. Please email us directly.");
    }

    perClient.hit(req.ip ?? "unknown");
    everyone.hit("all");

    try {
      await mailer.send({ name: body.name, email: body.email, message: body.message });
    } catch (err) {
      // Log connection metadata only (never messages, names, addresses, credentials or server response text).
      const e = (err ?? {}) as { code?: unknown; syscall?: unknown; address?: unknown; port?: unknown; command?: unknown; responseCode?: unknown; name?: unknown };
      const pick = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, 60) : "-");
      console.error(
        `[kaamsetu] contact mail failed: code=${pick(e.code ?? e.name)} syscall=${pick(e.syscall)} address=${pick(e.address)} port=${pick(e.port)} command=${pick(e.command)} responseCode=${pick(e.responseCode)}`,
      );
      const code = typeof e.code === "string" ? e.code : "";
      // 504: the mail server never answered in time. 503: could not connect/negotiate. 502: it answered and refused.
      const status = /TIMEDOUT|TIMEOUT/.test(code) ? 504 : /^(ESOCKET|ECONNECTION|ECONNREFUSED|ECONNRESET|EDNS|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)$/.test(code) ? 503 : 502;
      throw new ApiError(status, "contact_failed", "We couldn't send your message. Please email us directly.");
    }
    res.status(202).json({ ok: true });
  });

  return r;
}
