import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, installFetch, meFor, renderApp, signInAs } from "./helpers";
import { fakeSupabase } from "./fakeSupabase";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

const emptyJobs = { json: { jobs: [], page: { limit: 20, offset: 0 } } };

describe("landing page", () => {
  it("explains KaamSetu and offers both journeys when signed out", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /short-term work/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "I need workers" })).toHaveAttribute("href", "/signup?role=employer");
    expect(screen.getByRole("link", { name: "I'm looking for work" })).toHaveAttribute("href", "/signup?role=worker");
    expect(screen.getByText(/no aadhaar/i, { selector: "p" })).toBeInTheDocument();
  });

  it("labels the sample job card as an illustration, not a real listing", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    expect(await screen.findByText(/illustration · not a real listing/i)).toBeInTheDocument();
  });

  it("has no hackathon or hosting-provider branding anywhere on the page", async () => {
    installFetch({ ...baseRoutes("worker") });
    const { container } = renderApp("/");
    await screen.findByRole("heading", { level: 1, name: /short-term work/i });
    expect(container.textContent ?? "").not.toMatch(/hackathon|godaddy/i);
  });

  it("shows a Contact section in the footer with a clickable email link", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    const footer = (await screen.findByRole("heading", { name: "Contact" })).closest("footer") as HTMLElement;
    expect(footer).not.toBeNull();
    expect(within(footer).getByRole("link", { name: "info@kaamsetu.tech" })).toHaveAttribute("href", "mailto:info@kaamsetu.tech");
  });

  it("offers a dashboard link when already signed in", async () => {
    signInAs("employer");
    installFetch({ ...baseRoutes("employer") });
    renderApp("/");
    expect(await screen.findByRole("link", { name: "Open your dashboard" })).toHaveAttribute("href", "/employer");
  });
});

describe("route guards", () => {
  it("sends signed-out visitors to the login page", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/worker");
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("sends signed-out visitors away from every protected area", async () => {
    for (const path of ["/employer", "/employer/jobs/new", "/worker/profile", "/notifications"]) {
      installFetch({ ...baseRoutes("worker") });
      const { unmount } = renderApp(path);
      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      unmount();
    }
  });

  it("keeps workers out of employer pages", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/employer/jobs/new");
    expect(await screen.findByRole("heading", { name: "Find work" })).toBeInTheDocument();
  });

  it("keeps employers out of worker pages", async () => {
    signInAs("employer");
    installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": emptyJobs });
    renderApp("/worker/profile");
    expect(await screen.findByRole("heading", { name: "My jobs" })).toBeInTheDocument();
  });

  it("shows a recoverable error when the account has no profile", async () => {
    signInAs("worker");
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me": { status: 403, json: { error: { code: "profile_missing", message: "No KaamSetu profile exists for this account." } } },
    });
    renderApp("/worker");
    expect(await screen.findByText(/no kaamsetu profile/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows a friendly message when the server is unreachable at startup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    signInAs("worker");
    renderApp("/worker");
    expect(await screen.findByText(/couldn't load your account|unavailable/i)).toBeInTheDocument();
  });
});

describe("login", () => {
  it("validates before calling Supabase", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/login");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(fakeSupabase.client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("shows a friendly message for wrong credentials", async () => {
    fakeSupabase.signInError = "Invalid login credentials";
    installFetch({ ...baseRoutes("worker") });
    renderApp("/login");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "ravi@example.com");
    await user.type(screen.getByLabelText(/^Password/), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That email and password don't match");
  });

  it("explains unconfirmed emails", async () => {
    fakeSupabase.signInError = "Email not confirmed";
    installFetch({ ...baseRoutes("worker") });
    renderApp("/login");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "ravi@example.com");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/confirm your email/i);
  });

  it("signs in and lands on the role's dashboard", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/login");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "ravi@example.com");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Find work" })).toBeInTheDocument();
    expect(fakeSupabase.client.auth.signInWithPassword).toHaveBeenCalledWith({ email: "ravi@example.com", password: "password123" });
  });

  it("signs out from the app shell", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/worker");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Find work" });
    await user.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });
});

describe("sign-up", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, over: { name?: string; email?: string; password?: string } = {}) {
    await user.type(await screen.findByLabelText(/^Full name/), over.name ?? "Ravi Patel");
    await user.type(screen.getByLabelText(/^Email/), over.email ?? "ravi@example.com");
    await user.type(screen.getByLabelText(/^Password/), over.password ?? "password123");
  }

  it("requires a role, name, valid email and an 8-character password", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/signup");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/choose whether you're looking for work/i)).toBeInTheDocument();
    expect(screen.getByText(/enter your name/i)).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(fakeSupabase.client.auth.signUp).not.toHaveBeenCalled();
  });

  it("pre-selects the role from the link the user came from", async () => {
    installFetch({ ...baseRoutes("employer") });
    renderApp("/signup?role=employer");
    expect(await screen.findByRole("radio", { name: /i need workers/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /looking for work/i })).not.toBeChecked();
  });

  it("sends the chosen role and name as signup metadata and asks the user to confirm their email", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/signup");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /looking for work/i }));
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("ravi@example.com")).toBeInTheDocument();
    expect(fakeSupabase.signUpCalls).toHaveLength(1);
    expect(fakeSupabase.signUpCalls[0]).toMatchObject({
      email: "ravi@example.com",
      password: "password123",
      options: { data: { role: "worker", full_name: "Ravi Patel" } },
    });
  });

  it("goes straight to the dashboard when no email confirmation is required", async () => {
    fakeSupabase.signUpReturnsSession = true;
    installFetch({ ...baseRoutes("employer", meFor("employer")), "GET /api/employer/jobs": emptyJobs });
    renderApp("/signup");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /i need workers/i }));
    await fill(user, { name: "Shree Traders", email: "shree@example.com" });
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "My jobs" })).toBeInTheDocument();
  });

  it("shows a friendly error for an existing account", async () => {
    fakeSupabase.signUpError = "User already registered";
    installFetch({ ...baseRoutes("worker") });
    renderApp("/signup?role=worker");
    const user = userEvent.setup();
    await fill(user);
    await user.click(await screen.findByRole("button", { name: "Create account" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i));
  });
});
