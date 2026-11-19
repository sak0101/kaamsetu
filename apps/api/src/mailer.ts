import nodemailer from "nodemailer";
import type { MailConfig } from "./config";

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

export interface ContactMailer {
  send(msg: ContactMessage): Promise<void>;
}

/** The slice of a nodemailer transport this module needs (lets tests inject a fake). */
export interface MailTransport {
  sendMail(options: { from: string; to: string; replyTo: string; subject: string; text: string }): Promise<unknown>;
}

/** Remove CR/LF and other control characters so user input can never add mail headers. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Sends contact-form messages from the authenticated mailbox (From = SMTP_USER) to CONTACT_TO,
 * with the visitor's address as Reply-To. The visitor's address is never used as From, so SPF/DKIM
 * stay aligned and nobody can spoof a sender. Port 465 uses implicit TLS; other ports require STARTTLS.
 * Nothing here logs the message, the name or the address.
 */
export function createContactMailer(cfg: MailConfig, transport?: MailTransport): ContactMailer {
  const t: MailTransport =
    transport ??
    (nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      requireTLS: cfg.port !== 465,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    }) as unknown as MailTransport);

  return {
    async send({ name, email, message }) {
      const cleanName = oneLine(name);
      const cleanEmail = oneLine(email);
      await t.sendMail({
        from: `"KaamSetu website" <${cfg.user}>`,
        to: cfg.to,
        replyTo: `"${cleanName.replace(/"/g, "")}" <${cleanEmail}>`,
        subject: `KaamSetu contact form: ${cleanName.slice(0, 60)}`,
        text: `From: ${cleanName} <${cleanEmail}>\n\n${message.replace(/\r\n/g, "\n")}\n\n--\nSent from the KaamSetu website contact form.`,
      });
    },
  };
}
