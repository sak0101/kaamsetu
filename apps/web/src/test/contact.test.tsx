import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, renderApp } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

async function openForm() {
  const user = userEvent.setup();
  renderApp("/");
  const form = await screen.findByRole("form", { name: "Contact KaamSetu" });
  return { user, form };
}

async function fill(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, v: { name?: string; email?: string; message?: string }) {
  if (v.name !== undefined) await user.type(within(form).getByLabelText(/Your name/), v.name);
  if (v.email !== undefined) await user.type(within(form).getByLabelText(/Your email/), v.email);
  if (v.message !== undefined) await user.type(within(form).getByLabelText(/^Message/), v.message);
}

describe("footer contact form", () => {
  it("is in the footer next to a visible email fallback", async () => {
    installFetch({ ...baseRoutes("worker") });
    const { form } = await openForm();
    const footer = form.closest("footer") as HTMLElement;
    expect(footer).not.toBeNull();
    expect(within(footer).getAllByRole("link", { name: "info@kaamsetu.tech" })[0]).toHaveAttribute("href", "mailto:info@kaamsetu.tech");
    expect(within(form).getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("validates without calling the API", async () => {
    const f = installFetch({ ...baseRoutes("worker") });
    const { user, form } = await openForm();
    await fill(user, form, { name: "A", email: "nope", message: "short" });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    expect(within(form).getByText(/Enter your name/)).toBeInTheDocument();
    expect(within(form).getByText(/valid email address/)).toBeInTheDocument();
    expect(within(form).getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(f.callsTo("POST /api/contact")).toHaveLength(0);
  });

  it("sends the message without credentials, with an empty honeypot, then shows success", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = installFetch({ ...baseRoutes("worker"), "POST /api/contact": { status: 202, json: { ok: true } } });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/api/contact")) await gate; // hold the request so the loading state is observable
      return real(...args);
    }));
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop for helpers." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));

    const sending = await within(form).findByRole("button", { name: /Sending/ });
    expect(sending).toBeDisabled();
    expect(sending).toHaveAttribute("aria-busy", "true");
    release();

    expect(await screen.findByText(/your message was sent/i)).toBeInTheDocument();
    const call = f.callsTo("POST /api/contact")[0]!;
    expect(call.body).toEqual({ name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop for helpers.", website: "" });
    expect(call.headers.Authorization).toBeUndefined();
    // the form is cleared when the user chooses to send another
    await user.click(screen.getByRole("button", { name: "Send another message" }));
    expect(within(await screen.findByRole("form", { name: "Contact KaamSetu" })).getByLabelText(/Your name/)).toHaveValue("");
  });

  it("in demo mode shows the received message and a Demo mode note, and never says an email was sent", async () => {
    installFetch({ ...baseRoutes("worker"), "POST /api/contact": { status: 202, json: { ok: true, demo: true } } });
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Thank you! Your request has been received.")).toBeInTheDocument();
    expect(screen.getByText(/Demo mode/)).toHaveTextContent(/simulated, no email was sent/);
    expect(screen.queryByText(/your message was sent/i)).not.toBeInTheDocument();
  });

  it("without the demo flag a real success shows no Demo mode note", async () => {
    installFetch({ ...baseRoutes("worker"), "POST /api/contact": { status: 202, json: { ok: true } } });
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/your message was sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/Demo mode/)).not.toBeInTheDocument();
  });

  it("shows the server's message for a rate limit and keeps what was typed", async () => {
    installFetch({
      ...baseRoutes("worker"),
      "POST /api/contact": { status: 429, json: { error: { code: "contact_rate_limited", message: "You've sent several messages recently." } } },
    });
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/several messages recently/);
    expect(within(form).getByLabelText(/Your name/)).toHaveValue("Asha Patel");
    expect(within(form).getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it.each([
    ["not configured", 503, "contact_not_configured"],
    ["a send failure", 502, "contact_failed"],
  ])("points to the email address when the form is unavailable (%s)", async (_label, status, code) => {
    installFetch({ ...baseRoutes("worker"), "POST /api/contact": { status, json: { error: { code, message: "server text" } } } });
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent(/email us at info@kaamsetu\.tech/);
    expect(alert).not.toHaveTextContent("server text");
  });

  it("points to the email address when the network is down", async () => {
    installFetch({ ...baseRoutes("worker") });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/api/contact")) throw new TypeError("offline");
      return real(...args);
    }));
    const { user, form } = await openForm();
    await fill(user, form, { name: "Asha Patel", email: "asha@example.com", message: "I would like to list my shop." });
    await user.click(within(form).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent(/info@kaamsetu\.tech/));
  });

  it("hides the honeypot from people and assistive technology", async () => {
    installFetch({ ...baseRoutes("worker") });
    const { form } = await openForm();
    const trap = form.querySelector('input[name="website"]') as HTMLInputElement;
    expect(trap).not.toBeNull();
    expect(trap.tabIndex).toBe(-1);
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
