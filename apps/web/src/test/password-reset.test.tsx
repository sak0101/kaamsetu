import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecoveryHash } from "../lib/auth";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, renderApp } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => {
  fakeSupabase.reset();
  installFetch({ ...baseRoutes("worker") });
});
afterEach(() => {
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("readRecoveryHash", () => {
  it("recognises a recovery link, an expired link, and an ordinary page", () => {
    expect(readRecoveryHash("#access_token=abc&refresh_token=r&type=recovery")).toEqual({ recovering: true, linkError: null });
    expect(readRecoveryHash("#error=access_denied&error_code=otp_expired&error_description=expired").linkError).toMatch(/expired/);
    expect(readRecoveryHash("")).toEqual({ recovering: false, linkError: null });
    // a signup-confirmation hash must not be mistaken for recovery
    expect(readRecoveryHash("#access_token=abc&type=signup").recovering).toBe(false);
  });
});

describe("forgot password", () => {
  it("is linked from the login page", async () => {
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  });

  it("validates the email without calling Supabase", async () => {
    renderApp("/forgot-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "nope");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByText(/Enter the email address you signed up with/)).toBeInTheDocument();
    expect(fakeSupabase.resetCalls).toHaveLength(0);
  });

  it("asks Supabase to email a link that returns to /reset-password, and never reveals whether the account exists", async () => {
    renderApp("/forgot-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "  someone@example.com ");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(/If there is a KaamSetu account for/)).toBeInTheDocument();
    expect(fakeSupabase.resetCalls).toEqual([{ email: "someone@example.com", redirectTo: `${window.location.origin}/reset-password` }]);
  });

  it("shows a friendly message when rate-limited, and keeps the form", async () => {
    fakeSupabase.resetError = "For security purposes, you can only request this after 52 seconds.";
    renderApp("/forgot-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
  });
});

describe("reset password", () => {
  it("without a recovery link, explains and offers a new link", async () => {
    renderApp("/reset-password");
    expect(await screen.findByText(/Open the reset link from your email/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute("href", "/forgot-password");
  });

  it("shows an expired or already-used link clearly", async () => {
    window.location.hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
    renderApp("/reset-password");
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/);
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument();
  });

  it("shows the form when the recovery link is in the URL, validates, then saves, signs out and returns to login", async () => {
    window.location.hash = "#access_token=abc&refresh_token=r&type=recovery";
    renderApp("/reset-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^New password/), "short");
    await user.type(screen.getByLabelText(/^Confirm new password/), "different");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText(/don't match/)).toBeInTheDocument();
    expect(fakeSupabase.updatedPasswords).toHaveLength(0);

    await user.clear(screen.getByLabelText(/^New password/));
    await user.clear(screen.getByLabelText(/^Confirm new password/));
    await user.type(screen.getByLabelText(/^New password/), "a-new-password");
    await user.type(screen.getByLabelText(/^Confirm new password/), "a-new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getByText(/Your password was updated/)).toBeInTheDocument();
    expect(fakeSupabase.updatedPasswords).toEqual(["a-new-password"]);
    expect(fakeSupabase.client.auth.signOut).toHaveBeenCalled();
  });

  it("also recognises the PASSWORD_RECOVERY event (when the hash was already consumed)", async () => {
    renderApp("/reset-password");
    await screen.findByText(/Open the reset link from your email/);
    fakeSupabase.recover();
    expect(await screen.findByLabelText(/^New password/)).toBeInTheDocument();
  });

  it("explains an expired session at save time and offers a new link", async () => {
    window.location.hash = "#access_token=abc&type=recovery";
    fakeSupabase.updateUserError = "Auth session missing!";
    renderApp("/reset-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^New password/), "a-new-password");
    await user.type(screen.getByLabelText(/^Confirm new password/), "a-new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/);
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toBeInTheDocument();
  });

  it("rejects reusing the old password with a clear message", async () => {
    window.location.hash = "#access_token=abc&type=recovery";
    fakeSupabase.updateUserError = "New password should be different from the old password.";
    renderApp("/reset-password");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^New password/), "a-new-password");
    await user.type(screen.getByLabelText(/^Confirm new password/), "a-new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/haven't used before/));
  });
});

describe("normal login is unchanged", () => {
  it("still signs in and redirects", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/me/bookings": { json: { bookings: [] } }, "GET /api/me/applications": { json: { applications: [] } }, "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    renderApp("/login");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Email/), "ravi@example.com");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Find work" })).toBeInTheDocument();
  });
});
