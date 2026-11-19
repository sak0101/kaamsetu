import { useState, type FormEvent } from "react";
import { ApiError, api } from "../lib/api";
import { Alert, Button, TextAreaField, TextField } from "./ui";

export const CONTACT_EMAIL = "info@kaamsetu.tech";

type Errors = { name?: string; email?: string; message?: string };

/** Mirrors the server's rules (the server re-validates everything). */
export function validateContact(v: { name: string; email: string; message: string }): Errors {
  const e: Errors = {};
  const name = v.name.trim();
  if (name.length < 2 || name.length > 80) e.name = "Enter your name (2 to 80 characters).";
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim()) || v.email.trim().length > 120) e.email = "Enter a valid email address.";
  const msg = v.message.trim();
  if (msg.length < 10) e.message = "Write a few words so we can help (at least 10 characters).";
  else if (msg.length > 2000) e.message = "Please keep it under 2000 characters.";
  return e;
}

/**
 * Footer contact form. Light card so the fields keep full contrast inside the dark footer.
 * The email address stays visible as a fallback, and a failed or unavailable form says so plainly.
 */
export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot: people never see or fill this
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const next = validateContact({ name, email, message });
    setErrors(next);
    if (Object.keys(next).length) return;

    setState("sending");
    try {
      await api.sendContact({ name: name.trim(), email: email.trim(), message: message.trim(), website });
      setState("sent");
      setName("");
      setEmail("");
      setMessage("");
    } catch (err) {
      setState("idle");
      setFailure(
        err instanceof ApiError && err.status !== 0 && err.code !== "contact_failed" && err.code !== "contact_not_configured"
          ? err.message
          : `We couldn't send your message right now. Please email us at ${CONTACT_EMAIL}.`,
      );
    }
  }

  if (state === "sent") {
    return (
      <div className="mt-4 text-ink">
        <Alert tone="success" title="Thank you, your message was sent.">
          We'll reply to the email address you gave us.{" "}
          <button type="button" onClick={() => setState("idle")} className="font-semibold underline">
            Send another message
          </button>
        </Alert>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Contact KaamSetu" className="mt-4 flex flex-col gap-4 rounded-xl bg-paper p-4 text-ink sm:p-5">
      {failure && <Alert tone="error">{failure}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Your name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <TextField label="Your email" type="email" autoComplete="email" required maxLength={120} value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      </div>
      <TextAreaField label="Message" required maxLength={2000} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} error={errors.message} hint={`${message.trim().length} / 2000`} />
      {/* Honeypot: off-screen, not focusable, ignored by screen readers. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Leave this field empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={state === "sending"}>{state === "sending" ? "Sending…" : "Send message"}</Button>
        <p className="text-sm text-ink-soft">
          Or email <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline">{CONTACT_EMAIL}</a>
        </p>
      </div>
    </form>
  );
}
