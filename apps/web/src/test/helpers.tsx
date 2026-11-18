import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AppRoutes } from "../App";
import { AuthProvider } from "../lib/auth";
import type { Job, MeResponse, Role } from "../lib/types";
import { fakeSupabase } from "./fakeSupabase";

export const WORKER_ID = "11111111-1111-4111-8111-111111111111";
export const EMPLOYER_ID = "22222222-2222-4222-8222-222222222222";

type Handler = { status?: number; json?: unknown } | ((req: { url: URL; body: any }) => { status?: number; json?: unknown });
export interface Call { method: string; path: string; search: string; body: any; headers: Record<string, string> }

/** Routes are keyed "METHOD /api/path" (query string ignored). Unmatched requests fail the test loudly. */
export function installFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const table = { ...routes };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      calls.push({ method, path: url.pathname, search: url.search, body, headers });
      const handler = table[`${method} ${url.pathname}`];
      if (!handler) {
        unmatched.push(`${method} ${url.pathname}`);
        return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      const res = typeof handler === "function" ? handler({ url, body }) : handler;
      const status = res.status ?? 200;
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(res.json ?? {}), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return {
    calls,
    unmatched,
    set: (key: string, handler: Handler) => {
      table[key] = handler;
    },
    callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  };
}

export const CATEGORIES = [
  { id: 1, slug: "loading_unloading", name_en: "Loading & unloading", name_hi: "x", name_gu: "y" },
  { id: 2, slug: "cleaning", name_en: "Cleaning", name_hi: "x", name_gu: "y" },
];
export const LOCALITIES = [
  { id: 1, city: "Vadodara", name: "Alkapuri" },
  { id: 2, city: "Vadodara", name: "Gotri" },
];

export const meFor = (role: Role, over: Partial<MeResponse> = {}): MeResponse => ({
  profile: {
    id: role === "worker" ? WORKER_ID : EMPLOYER_ID,
    role,
    full_name: role === "worker" ? "Ravi Patel" : "Shree Traders",
    org_name: null,
    preferred_language: "en",
    created_at: "2026-11-01T00:00:00+00:00",
    updated_at: "2026-11-01T00:00:00+00:00",
  },
  worker: role === "worker" ? { user_id: WORKER_ID, bio: null, years_experience: 3, locality_id: 1, is_available: true, category_ids: [1] } : null,
  ...over,
});

export const job = (over: Partial<Job> = {}): Job => ({
  id: "33333333-3333-4333-8333-333333333333",
  employer_id: EMPLOYER_ID,
  category_id: 1,
  locality_id: 1,
  title: "Shift household goods",
  description: "Third floor, no lift.\nBring a trolley if you have one.",
  starts_at: "2099-11-25T03:30:00+00:00", // 9:00 AM IST
  ends_at: "2099-11-25T07:30:00+00:00", // 1:00 PM IST
  workers_needed: 2,
  pay_type: "daily",
  pay_amount_paise: 85000,
  status: "open",
  positions_filled: 0,
  cancelled_reason: null,
  created_at: "2026-11-20T00:00:00+00:00",
  employer: { full_name: "Shree Traders", org_name: null },
  ...over,
});

/** Baseline routes every signed-in screen needs. */
export function baseRoutes(role: Role, me: MeResponse = meFor(role)): Record<string, Handler> {
  return {
    "GET /api/public-config": { json: { supabaseUrl: "http://sb.test", supabaseAnonKey: "anon-key" } },
    "GET /api/me": { json: me },
    "GET /api/categories": { json: { categories: CATEGORIES } },
    "GET /api/localities": { json: { localities: LOCALITIES } },
    "GET /api/notifications": { json: { notifications: [] } },
    "GET /api/me/contact": { json: { phone: null } },
    "GET /api/ai/status": { json: { available: true } },
  };
}

export function signInAs(role: Role) {
  fakeSupabase.signInAs(role === "worker" ? WORKER_ID : EMPLOYER_ID);
}

export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}
