import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, job, meFor, renderApp, signInAs } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => {
  fakeSupabase.reset();
  signInAs("worker");
});
afterEach(() => vi.unstubAllGlobals());

const CATS = [
  { id: 1, slug: "loading_unloading", name_en: "Loading & unloading", name_hi: "लोडिंग-अनलोडिंग", name_gu: "લોડિંગ-અનલોડિંગ" },
  { id: 2, slug: "cleaning", name_en: "Cleaning", name_hi: "सफाई", name_gu: "સફાઈ" },
];
const withLanguage = (preferred_language: "en" | "hi" | "gu") => {
  const me = meFor("worker");
  return { ...baseRoutes("worker", { ...me, profile: { ...me.profile, preferred_language } }), "GET /api/categories": { json: { categories: CATS } } };
};
const quiet = {
  "GET /api/jobs": { json: { jobs: [job()], page: { limit: 20, offset: 0 } } },
  "GET /api/me/bookings": { json: { bookings: [] } },
  "GET /api/me/applications": { json: { applications: [] } },
};

describe("localised work-type names", () => {
  it.each([
    ["en", "Loading & unloading", "Cleaning"],
    ["hi", "लोडिंग-अनलोडिंग", "सफाई"],
    ["gu", "લોડિંગ-અનલોડિંગ", "સફાઈ"],
  ] as const)("shows work types in %s on the dropdown and on job cards", async (lang, loading, cleaning) => {
    installFetch({ ...withLanguage(lang), ...quiet });
    renderApp("/worker");
    const card = (await screen.findByRole("link", { name: "Shift household goods" })).closest("article") as HTMLElement;
    expect(within(card).getByText(new RegExp(loading.replace(/[&]/g, "\\$&")))).toBeInTheDocument();
    const select = screen.getAllByLabelText("Type of work").at(-1) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(expect.arrayContaining([loading, cleaning]));
  });

  it("falls back to English when a translation is missing", async () => {
    const routes = withLanguage("hi");
    installFetch({
      ...routes,
      "GET /api/categories": { json: { categories: [{ id: 1, slug: "loading_unloading", name_en: "Loading & unloading", name_hi: "", name_gu: "" }] } },
      ...quiet,
    });
    renderApp("/worker");
    const card = (await screen.findByRole("link", { name: "Shift household goods" })).closest("article") as HTMLElement;
    expect(within(card).getByText(/Loading & unloading/)).toBeInTheDocument();
  });
});

describe("choosing a language", () => {
  it("saves the language with the profile, without disturbing the other fields", async () => {
    const f = installFetch({
      ...withLanguage("en"),
      "PUT /api/me/profile": { json: { profile: meFor("worker").profile } },
      "PUT /api/me/worker-profile": { json: { worker: {} } },
    });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    const select = await screen.findByLabelText("Language");
    expect(select).toHaveValue("en");
    await user.selectOptions(select, "gu");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await screen.findByText(/saved/i);
    expect(f.callsTo("PUT /api/me/profile")[0]!.body).toMatchObject({ full_name: "Ravi Patel", preferred_language: "gu" });
  });

  it("leaves the profile call out entirely when nothing about the account changed", async () => {
    const f = installFetch({ ...withLanguage("hi"), "PUT /api/me/worker-profile": { json: { worker: {} } } });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    expect(await screen.findByLabelText("Language")).toHaveValue("hi");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await screen.findByText(/saved/i);
    expect(f.callsTo("PUT /api/me/profile")).toHaveLength(0);
  });
});
