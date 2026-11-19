import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { loadMailConfig } from "./config";
import { createContactMailer, type ContactMailer, type ContactMessage, type MailTransport } from "./mailer";

const valid = { name: "Asha Patel", email: "asha@example.com", message: "Hello, I would like to list my shop for helpers." };

describe("loadMailConfig", () => {
  const base = { SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_USER: "info@kaamsetu.tech", SMTP_PASS: "not-a-real-secret" };

  it("is disabled (null) unless host, port, user and password are all set", () => {
    expect(loadMailConfig({})).toBeNull();
    for (const k of Object.keys(base)) {
      expect(loadMailConfig({ ...base, [k]: "" })).toBeNull();
    }
  });

  it("defaults the recipient to info@kaamsetu.tech and allows an override", () => {
    expect(loadMailConfig(base)).toMatchObject({ host: "smtp.example.test", port: 465, user: "info@kaamsetu.tech", to: "info@kaamsetu.tech" });
    expect(loadMailConfig({ ...base, CONTACT_TO: "team@kaamsetu.tech" })?.to).toBe("team@kaamsetu.tech");
  });

  it("rejects a bad port, a non-address user or a bad recipient, naming the variable but never a value", () => {
    expect(() => loadMailConfig({ ...base, SMTP_PORT: "99999" })).toThrow(/SMTP_PORT/);
    expect(() => loadMailConfig({ ...base, SMTP_USER: "apikey" })).toThrow(/SMTP_USER/);
    expect(() => loadMailConfig({ ...base, CONTACT_TO: "nope" })).toThrow(/CONTACT_TO/);
    try {
      loadMailConfig({ ...base, SMTP_PORT: "abc" });
    } catch (e) {
      expect((e as Error).message).not.toContain("not-a-real-secret");
    }
  });
});

describe("createContactMailer", () => {
  const cfg = { host: "h", port: 465, user: "info@kaamsetu.tech", pass: "p", to: "info@kaamsetu.tech" };

  it("sends from the authenticated mailbox, to CONTACT_TO, with the visitor as Reply-To", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const mailer = createContactMailer(cfg, { sendMail } as MailTransport);
    await mailer.send(valid);
    const opts = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(opts.from).toContain("<info@kaamsetu.tech>");
    expect(opts.from).not.toContain("asha@example.com");
    expect(opts.to).toBe("info@kaamsetu.tech");
    expect(opts.replyTo).toContain("<asha@example.com>");
    expect(opts.text).toContain("Hello, I would like to list my shop");
  });

  it("cannot be used to inject mail headers through the name", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await createContactMailer(cfg, { sendMail } as MailTransport).send({ ...valid, name: "Eve\r\nBcc: victim@example.com" });
    const opts = sendMail.mock.calls[0]![0] as Record<string, string>;
    expect(opts.subject).not.toMatch(/[\r\n]/);
    expect(opts.replyTo).not.toMatch(/[\r\n]/);
  });
});

describe("POST /api/contact", () => {
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base: string;
  let send: ReturnType<typeof vi.fn<(m: ContactMessage) => Promise<void>>>;
  let logs: ReturnType<typeof vi.spyOn>[];

  async function start(mailer: ContactMailer | null, contactDemo = false) {
    server = createApp({ mailer, contactDemo }).listen(0); // no Supabase deps: the route must still work
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const post = (body: unknown) =>
    fetch(`${base}/api/contact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(() => {
    send = vi.fn<(m: ContactMessage) => Promise<void>>().mockResolvedValue(undefined);
    logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  });
  afterEach(() => {
    server.close();
    vi.restoreAllMocks();
  });

  it("delivers a valid message without needing Supabase", async () => {
    await start({ send });
    const res = await post(valid);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(valid);
  });

  it("validates name, email and message with field details", async () => {
    await start({ send });
    for (const bad of [{ ...valid, name: "A" }, { ...valid, email: "not-an-email" }, { ...valid, message: "short" }, { ...valid, message: "x".repeat(2001) }, { ...valid, extra: 1 }]) {
      const res = await post(bad);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_error");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("silently drops honeypot submissions: looks like success, sends nothing", async () => {
    await start({ send });
    const res = await post({ ...valid, website: "http://spam.example" });
    expect(res.status).toBe(202);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 503 contact_not_configured when SMTP isn't set up", async () => {
    await start(null);
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("contact_not_configured");
  });

  it("rate-limits a client after 5 messages in an hour", async () => {
    await start({ send });
    for (let i = 0; i < 5; i++) expect((await post(valid)).status).toBe(202);
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("contact_rate_limited");
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("returns a generic 502 on send failure and never logs the message, name, address or server text", async () => {
    send.mockRejectedValue(Object.assign(new Error("535 login failed for info@kaamsetu.tech with secret-pass"), { code: "EAUTH" }));
    await start({ send });
    const res = await post(valid);
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("contact_failed");
    expect(text).not.toMatch(/535|secret-pass|kaamsetu\.tech/);
    const logged = logs.flatMap((l) => l.mock.calls.flat()).join(" ");
    expect(logged).toContain("EAUTH");
    expect(logged).not.toMatch(/Asha|asha@example|shop for helpers|secret-pass/);
  });

  it.each([
    ["ESOCKET", 503],
    ["ETIMEDOUT", 504],
    ["ECONNECTION", 503],
  ])("maps SMTP %s to %i and logs only connection metadata", async (code, status) => {
    send.mockRejectedValue(Object.assign(new Error("boom secret-pass"), { code, syscall: "connect", address: "1.2.3.4", port: 465 }));
    await start({ send });
    const res = await post(valid);
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).toContain("contact_failed");
    const logged = logs.flatMap((l) => l.mock.calls.flat()).join(" ");
    expect(logged).toContain(`code=${code}`);
    expect(logged).toContain("syscall=connect");
    expect(logged).toContain("port=465");
    expect(logged).not.toMatch(/secret-pass|Asha|asha@example/);
  });

  describe("demo mode (CONTACT_DEMO_MODE)", () => {
    it("acknowledges a valid submission as simulated: demo:true, nothing sent, nothing logged", async () => {
      await start({ send }, true);
      const res = await post(valid);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, demo: true });
      expect(send).not.toHaveBeenCalled();
      expect(logs.flatMap((l) => l.mock.calls.flat()).join(" ")).not.toMatch(/Asha|asha@example|shop for helpers/);
    });

    it("works with no SMTP configured at all", async () => {
      await start(null, true);
      const res = await post(valid);
      expect(res.status).toBe(202);
      expect(((await res.json()) as { demo?: boolean }).demo).toBe(true);
    });

    it("still validates input", async () => {
      await start({ send }, true);
      const res = await post({ ...valid, email: "not-an-email" });
      expect(res.status).toBe(422);
    });

    it("is off by default: a real send answers { ok: true } with no demo flag", async () => {
      await start({ send });
      expect(await (await post(valid)).json()).toEqual({ ok: true });
    });
  });

  it("with demo mode off, an SMTP failure is still a real error and never looks like success", async () => {
    send.mockRejectedValue(Object.assign(new Error("boom"), { code: "EAUTH", responseCode: 535 }));
    await start({ send }, false);
    const res = await post(valid);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("contact_failed");
  });

  it("rejects an oversized body", async () => {
    await start({ send });
    const res = await post({ ...valid, message: "x".repeat(20_000) });
    expect(res.status).toBe(413);
  });
});
