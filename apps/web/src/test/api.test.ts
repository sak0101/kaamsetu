import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, configureApi } from "../lib/api";
import { installFetch } from "./helpers";

beforeEach(() => {
  configureApi({ getToken: async () => "jwt-123", onUnauthorized: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("API client", () => {
  it("sends the Supabase access token as a bearer header", async () => {
    const f = installFetch({ "GET /api/me": { json: { profile: {}, worker: null } } });
    await api.me();
    expect(f.calls[0]?.headers.Authorization).toBe("Bearer jwt-123");
  });

  it("does not send credentials to the public config endpoint", async () => {
    const f = installFetch({ "GET /api/public-config": { json: { supabaseUrl: "u", supabaseAnonKey: "k" } } });
    await api.publicConfig();
    expect(f.calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("builds query strings and drops empty values", async () => {
    const f = installFetch({ "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    await api.browseJobs({ limit: 20, offset: 40, locality_id: 3, category_id: undefined });
    expect(f.calls[0]?.search).toBe("?limit=20&offset=40&locality_id=3");
  });

  it("only ever sends user data in the body, never an acting user id", async () => {
    const f = installFetch({
      "POST /api/jobs/abc/applications": { status: 201, json: { application_id: "x" } },
      "POST /api/applications/app1/accept": { status: 201, json: { booking_id: "b" } },
      "POST /api/applications/app1/reject": { status: 204 },
    });
    await api.apply("abc", "I can start early");
    await api.accept("app1");
    await api.reject("app1", "Not a fit");
    expect(f.calls.map((c) => c.body)).toEqual([{ message: "I can start early" }, undefined, { reason: "Not a fit" }]);
    expect(JSON.stringify(f.calls.map((c) => c.body))).not.toMatch(/user_id|actor|employer_id|worker_id/);
  });

  it("returns undefined for 204 responses", async () => {
    installFetch({ "POST /api/applications/a/withdraw": { status: 204 } });
    await expect(api.withdraw("a")).resolves.toBeUndefined();
  });

  it("turns error responses into ApiError with code, message and field details", async () => {
    installFetch({
      "POST /api/jobs": {
        status: 422,
        json: { error: { code: "validation_error", message: "The request is invalid.", details: [{ path: "title", message: "Too short" }] } },
      },
    });
    const err = await api
      .createJob({ category_id: 1, locality_id: 1, title: "x", description: "d", starts_at: "s", ends_at: "e", workers_needed: 1, pay_type: "daily", pay_amount_paise: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "validation_error", details: [{ path: "title", message: "Too short" }] });
  });

  it("falls back to a friendly message for non-JSON failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const err = await api.me().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "error" });
    expect(err.message).not.toContain("<html>");
  });

  it("reports network failures as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await api.me().catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: "network_error" });
  });

  it("signs the user out when the API says the session is invalid", async () => {
    const onUnauthorized = vi.fn();
    configureApi({ onUnauthorized });
    installFetch({ "GET /api/me": { status: 401, json: { error: { code: "invalid_token", message: "expired" } } } });
    await api.me().catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
