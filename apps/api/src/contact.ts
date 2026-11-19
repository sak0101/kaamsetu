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
export function createContactRouter(mailer: ContactMailer | null): Router {
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

    if (!mailer) {
      throw new ApiError(503, "contact_not_configured", "The contact form isn't available right now. Please email us directly.");
    }

    perClient.hit(req.ip ?? "unknown");
    everyone.hit("all");

    try {
      await mailer.send({ name: body.name, email: body.email, message: body.message });
    } catch (err) {
      // Log the error kind only: SMTP errors can echo addresses or server details.
      console.error(`[kaamsetu] contact mail failed: ${(err as { code?: string }).code ?? (err as Error)?.name ?? "unknown"}`);
      throw new ApiError(502, "contact_failed", "We couldn't send your message. Please email us directly.");
    }
    res.status(202).json({ ok: true });
  });

  return r;
}
