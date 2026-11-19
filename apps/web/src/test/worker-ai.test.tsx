import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, meFor, renderApp, signInAs } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => {
  fakeSupabase.reset();
  signInAs("worker");
});
afterEach(() => vi.unstubAllGlobals());

const emptyWorker = () => {
  const me = meFor("worker");
  return { ...me, worker: { ...me.worker!, locality_id: null, years_experience: null, category_ids: [], skills: [], availability_note: null, bio: null } };
};
const draft = (over: Record<string, unknown> = {}) => ({
  draft: {
    bio: "I have loaded trucks for three years.", years_experience: 3, locality_id: 2, category_ids: [1], skills: ["lifting heavy loads"],
    availability_note: "Weekends", is_available: true, ...over,
  },
  assumptions: [],
  questions: [],
  missing_fields: [],
});
const describeIt = async (user: ReturnType<typeof userEvent.setup>, text = "Main Gotri mein rehta hoon aur teen saal se truck loading karta hoon.") => {
  await user.type(await screen.findByLabelText("Tell us about your work"), text);
  await user.click(screen.getByRole("button", { name: "Read my description" }));
};

describe("worker profile: Describe yourself", () => {
  it("drafts the profile from the worker's words, shows what it understood, and saves NOTHING until they press Save", async () => {
    const f = installFetch({
      ...baseRoutes("worker", emptyWorker()),
      "POST /api/ai/worker-profile-draft": { json: draft() },
      "PUT /api/me/worker-profile": { json: { worker: {} } },
    });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await describeIt(user);
    const group = await screen.findByRole("group", { name: "What I understood" });
    expect(within(group).getByText("Gotri")).toBeInTheDocument();
    expect(within(group).getByText("Loading & unloading")).toBeInTheDocument();
    expect(within(group).getByText("3 years")).toBeInTheDocument();
    expect(within(group).getByText("lifting heavy loads")).toBeInTheDocument();
    expect(f.callsTo("POST /api/ai/worker-profile-draft")[0]!.body).toEqual({ text: "Main Gotri mein rehta hoon aur teen saal se truck loading karta hoon." });
    expect(f.callsTo("PUT /api/me/worker-profile")).toHaveLength(0); // drafting saves nothing
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue(""); // and does not touch the form until they say so

    await user.click(within(group).getByRole("button", { name: "Fill my profile with this" }));
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue("2");
    expect(screen.getByRole("checkbox", { name: "Loading & unloading" })).toBeChecked();
    expect(screen.getByLabelText(/Years of experience/)).toHaveValue(3);
    expect(screen.getByRole("list", { name: "Your skills" })).toHaveTextContent("lifting heavy loads");
    expect(screen.getAllByText("Filled by AI: please check").length).toBeGreaterThanOrEqual(4); // every filled field is flagged
    expect(f.callsTo("PUT /api/me/worker-profile")).toHaveLength(0); // still nothing saved

    // the worker edits one thing, then saves through the ordinary profile API
    await user.clear(screen.getByLabelText(/Years of experience/));
    await user.type(screen.getByLabelText(/Years of experience/), "4");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(f.callsTo("PUT /api/me/worker-profile")[0]!.body).toMatchObject({ locality_id: 2, category_ids: [1], years_experience: 4, skills: ["lifting heavy loads"] });
    expect(screen.queryByText("Filled by AI: please check")).not.toBeInTheDocument(); // flags clear after saving
  });

  it("never invents: fields the worker didn't mention stay exactly as they were", async () => {
    const me = meFor("worker");
    installFetch({
      ...baseRoutes("worker", me),
      "POST /api/ai/worker-profile-draft": { json: draft({ bio: null, years_experience: null, locality_id: null, category_ids: [], skills: [], availability_note: "Evenings", is_available: null }) },
    });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Gotri" }); // reference data loaded
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue("1");
    await describeIt(user, "I am free in the evenings.");
    await user.click(await screen.findByRole("button", { name: "Fill my profile with this" }));
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue("1"); // unchanged
    expect(screen.getByLabelText(/Years of experience/)).toHaveValue(me.worker!.years_experience); // unchanged, not blanked or zeroed
    expect(screen.getByRole("checkbox", { name: "Loading & unloading" })).toBeChecked();
    expect(screen.getByLabelText(/^When are you available/)).toHaveValue("Evenings");
  });

  it("shows guesses and missing details so the worker can correct them", async () => {
    installFetch({
      ...baseRoutes("worker", emptyWorker()),
      "POST /api/ai/worker-profile-draft": {
        json: { ...draft({ locality_id: null, years_experience: null }), assumptions: [{ field: "categories", text: "Read 'truck pe maal' as loading work." }], questions: [{ field: "locality", question: "Which area do you work in?" }] },
      },
    });
    renderApp("/worker/profile");
    await describeIt(userEvent.setup());
    const group = await screen.findByRole("group", { name: "What I understood" });
    expect(within(group).getByText(/Read 'truck pe maal' as loading work/)).toBeInTheDocument();
    expect(within(group).getByText("Which area do you work in?")).toBeInTheDocument();
    expect(within(group).getAllByText("Not mentioned").length).toBeGreaterThanOrEqual(2);
  });

  it("can be discarded without changing anything", async () => {
    const f = installFetch({ ...baseRoutes("worker", emptyWorker()), "POST /api/ai/worker-profile-draft": { json: draft() } });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await describeIt(user);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("group", { name: "What I understood" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue("");
    expect(f.callsTo("PUT /api/me/worker-profile")).toHaveLength(0);
  });

  it("says plainly when nothing usable was found", async () => {
    installFetch({
      ...baseRoutes("worker", emptyWorker()),
      "POST /api/ai/worker-profile-draft": { json: draft({ bio: null, years_experience: null, locality_id: null, category_ids: [], skills: [], availability_note: null, is_available: null }) },
    });
    renderApp("/worker/profile");
    await describeIt(userEvent.setup(), "hello hello hello hello");
    expect(await screen.findByText(/couldn't find details I can use/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill my profile with this" })).not.toBeInTheDocument();
  });

  it("explains an AI outage and leaves the manual form fully usable", async () => {
    installFetch({
      ...baseRoutes("worker", emptyWorker()),
      "POST /api/ai/worker-profile-draft": { status: 503, json: { error: { code: "ai_unavailable", message: "The AI assistant is temporarily unavailable." } } },
    });
    renderApp("/worker/profile");
    await describeIt(userEvent.setup());
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/);
    expect(screen.getByText(/still fill in the form below yourself/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Area you work in/)).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
  });

  it("is hidden when the server has no AI key, and the manual form is untouched", async () => {
    installFetch({ ...baseRoutes("worker", emptyWorker()), "GET /api/ai/status": { json: { available: false } } });
    renderApp("/worker/profile");
    await screen.findByLabelText(/^Area you work in/);
    await waitFor(() => expect(screen.queryByText("Describe yourself")).not.toBeInTheDocument());
  });

  it("needs a real description before it will call the AI", async () => {
    const f = installFetch({ ...baseRoutes("worker", emptyWorker()) });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Tell us about your work"), "hi");
    expect(screen.getByRole("button", { name: "Read my description" })).toBeDisabled();
    expect(f.callsTo("POST /api/ai/worker-profile-draft")).toHaveLength(0);
  });
});
