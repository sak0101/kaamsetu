import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInput } from "../components/VoiceInput";
import { CategoryImage } from "../components/CategoryImage";
import type { AiDraftResult } from "../lib/api";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, job, meFor, renderApp, signInAs } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error cleanup of the test double
  delete window.SpeechRecognition;
  // @ts-expect-error cleanup of the test double
  delete window.webkitSpeechRecognition;
});

// ----------------------------------------------------------------- speech double
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started++;
    this.onstart?.();
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
  abort() {
    this.aborted++;
  }
  say(text: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text }, length: 1 }] });
  }
}
const installSpeech = () => {
  FakeRecognition.instances = [];
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
};
const lastRec = () => FakeRecognition.instances.at(-1)!;

describe("VoiceInput", () => {
  it("does not listen until the user presses the button (no background listening)", () => {
    installSpeech();
    render(<VoiceInput onText={() => {}} />);
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(screen.queryByText(/listening/i)).not.toBeInTheDocument();
  });

  it("listens for ONE utterance, shows a live indicator and interim text, and hands over the final phrase", async () => {
    installSpeech();
    const onText = vi.fn();
    render(<VoiceInput onText={onText} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    const rec = lastRec();
    expect(rec).toMatchObject({ lang: "en-IN", continuous: false, interimResults: true, started: 1 });
    expect(screen.getByText(/Listening… speak now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop listening" })).toBeInTheDocument();

    act(() => rec.say("I need eight help", false));
    expect(screen.getByText(/I need eight help/)).toBeInTheDocument();
    expect(onText).not.toHaveBeenCalled(); // interim text is never submitted

    act(() => rec.say("I need eight helpers for a wedding", true));
    expect(onText).toHaveBeenCalledWith("I need eight helpers for a wedding");

    act(() => rec.onend?.());
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speak" })).toBeInTheDocument();
  });

  it("stops when asked", async () => {
    installSpeech();
    render(<VoiceInput onText={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Speak" }));
    await user.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(lastRec().stopped).toBe(1);
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
  });

  it("aborts recognition if the component goes away (never keeps listening)", async () => {
    installSpeech();
    const { unmount } = render(<VoiceInput onText={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    unmount();
    expect(lastRec().aborted).toBe(1);
  });

  it.each([
    ["not-allowed", /Microphone access was blocked.*type instead/i],
    ["service-not-allowed", /Microphone access was blocked/i],
    ["no-speech", /didn't hear anything/i],
    ["audio-capture", /No microphone was found/i],
    ["network", /speech service couldn't be reached/i],
  ])("explains a '%s' error and keeps the typed input available", async (code, message) => {
    installSpeech();
    render(<VoiceInput onText={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    act(() => lastRec().onerror?.({ error: code }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Speak" })).toBeEnabled(); // can try again
  });

  it("says plainly when the browser has no speech recognition", () => {
    render(<VoiceInput onText={() => {}} />);
    expect(screen.queryByRole("button", { name: "Speak" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/isn't available in this browser.*Type your request instead/i);
  });
});

// ------------------------------------------------------------------ AI creation
const WEDDING =
  "I need 8 helpers for a wedding at a venue in Alkapuri, Vadodara tomorrow from 5 PM to midnight. Payment is ₹800 per person. They should help with guest coordination and basic arrangements.";

const readyDraft = (over: Partial<AiDraftResult> = {}): AiDraftResult => ({
  draft: {
    title: "Wedding helpers, Alkapuri",
    category_id: 1,
    locality_id: 1,
    description: "Helpers for a wedding at a venue in Alkapuri.\n\nWhat the workers will do:\n• Guest coordination\n• Basic arrangements",
    workers_needed: 8,
    date: "2099-11-20",
    start_time: "17:00",
    end_time: "00:00",
    ends_next_day: true,
    pay_type: "fixed",
    pay_amount_paise: 80000,
  },
  assumptions: [
    { field: "date", text: "Read 'tomorrow' as 2099-11-20." },
    { field: "pay_type", text: "₹800 per person treated as a fixed amount for the shift." },
    { field: "end_time", text: "Ends at 00:00 the next day (after midnight)." },
  ],
  questions: [],
  ready: true,
  missing_fields: [],
  ...over,
});

async function draftFrom(text: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^Describe the job/), text);
  await user.click(screen.getByRole("button", { name: "Create draft" }));
  return user;
}

describe("Create a job with AI", () => {
  beforeEach(() => signInAs("employer"));

  it("is offered prominently on the dashboard and beside the standard form", async () => {
    installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    const { unmount } = renderApp("/employer");
    expect((await screen.findAllByRole("link", { name: "Create a job with AI" }))[0]).toHaveAttribute("href", "/employer/jobs/new/ai");
    unmount();
    installFetch({ ...baseRoutes("employer") });
    renderApp("/employer/jobs/new");
    expect(await screen.findByRole("link", { name: "Create a job with AI" })).toHaveAttribute("href", "/employer/jobs/new/ai");
    expect(screen.getByLabelText(/^Job title/)).toBeInTheDocument(); // the standard form is still right there
  });

  it("sends the text to the backend, shows an editable preview, and publishes ONLY after explicit confirmation", async () => {
    const f = installFetch({
      ...baseRoutes("employer"),
      "POST /api/ai/job-draft": { json: readyDraft() },
      "POST /api/jobs": { status: 201, json: { id: "88888888-8888-4888-8888-888888888888" } },
      "GET /api/jobs/88888888-8888-4888-8888-888888888888": { json: { job: job({ id: "88888888-8888-4888-8888-888888888888", title: "Wedding helpers, Alkapuri" }), my_application: null } },
      "GET /api/jobs/88888888-8888-4888-8888-888888888888/applicants": { json: { applicants: [] } },
    });
    renderApp("/employer/jobs/new/ai");
    const user = await draftFrom(WEDDING);

    // the exact text went to the server-side AI endpoint
    expect(await screen.findByText("Your draft is ready to check")).toBeInTheDocument();
    expect(f.callsTo("POST /api/ai/job-draft")[0]?.body).toEqual({ text: WEDDING });

    // an editable preview, filled from the draft
    expect(screen.getByLabelText(/^Job title/)).toHaveValue("Wedding helpers, Alkapuri");
    expect(screen.getByLabelText(/^Workers needed/)).toHaveValue(8);
    expect(screen.getByLabelText(/^Amount/)).toHaveValue("800");
    expect(screen.getByLabelText(/^Pay is/)).toHaveValue("fixed");
    expect(screen.getByLabelText(/^Start time/)).toHaveValue("17:00");
    expect(screen.getByLabelText(/^End time/)).toHaveValue("00:00");
    expect(screen.getByRole("checkbox", { name: /Ends the next day/ })).toBeChecked();
    expect((screen.getByLabelText(/^What needs to be done/) as HTMLTextAreaElement).value).toContain("• Guest coordination");

    // assumptions are called out, and fields are labelled by where they came from
    expect(screen.getByText("What I assumed: please check")).toBeInTheDocument();
    expect(screen.getByText("₹800 per person treated as a fixed amount for the shift.")).toBeInTheDocument();
    expect(screen.getAllByText("Assumed: please check").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Filled by AI: please check").length).toBeGreaterThan(0);

    // NOTHING is published yet, and the publish button is locked until the organiser confirms
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0);
    const publish = screen.getByRole("button", { name: "Publish job" });
    expect(publish).toBeDisabled();

    // the organiser edits a field, then explicitly confirms
    const title = screen.getByLabelText(/^Job title/);
    await user.clear(title);
    await user.type(title, "Wedding helpers needed, Alkapuri");
    await user.click(screen.getByRole("checkbox", { name: /I've checked these details and I want to publish this job/ }));
    expect(publish).toBeEnabled();
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0); // still not published: ticking the box is not publishing
    await user.click(publish);

    expect(await screen.findByText("Job posted. Workers can now apply.")).toBeInTheDocument();
    expect(f.callsTo("POST /api/jobs")).toHaveLength(1);
    expect(f.callsTo("POST /api/jobs")[0]?.body).toEqual({
      category_id: 1,
      locality_id: 1,
      title: "Wedding helpers needed, Alkapuri", // the edit was kept
      description: "Helpers for a wedding at a venue in Alkapuri.\n\nWhat the workers will do:\n• Guest coordination\n• Basic arrangements",
      starts_at: "2099-11-20T17:00:00+05:30",
      ends_at: "2099-11-21T00:00:00+05:30", // 5 PM to midnight = ends the next IST day
      workers_needed: 8,
      pay_type: "fixed",
      pay_amount_paise: 80000,
    });
  });

  it("never publishes just from creating the draft or editing it", async () => {
    const f = installFetch({ ...baseRoutes("employer"), "POST /api/ai/job-draft": { json: readyDraft() } });
    renderApp("/employer/jobs/new/ai");
    const user = await draftFrom(WEDDING);
    await screen.findByText("Your draft is ready to check");
    await user.type(screen.getByLabelText(/^Job title/), " extra");
    await user.click(screen.getByRole("button", { name: "Edit my description" }));
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0);
  });

  it("asks follow-up questions instead of inventing missing details, and redrafts with the answers", async () => {
    const incomplete = readyDraft({
      draft: { ...readyDraft().draft, locality_id: null, pay_amount_paise: null, pay_type: null },
      questions: [
        { field: "locality", question: "Which locality in Vadodara is the work in?" },
        { field: "pay_amount", question: "How much will you pay each worker (in rupees)?" },
      ],
      ready: false,
      missing_fields: ["locality", "pay_amount", "pay_type"],
      assumptions: [],
    });
    const f = installFetch({
      ...baseRoutes("employer"),
      "POST /api/ai/job-draft": ({ body }) => ({ json: body.answers ? readyDraft() : incomplete }),
    });
    renderApp("/employer/jobs/new/ai");
    const user = await draftFrom("Need 8 helpers for a wedding tomorrow 5 PM to midnight");

    expect(await screen.findByText("A few details are missing or unclear")).toBeInTheDocument();
    // the missing fields are flagged and left EMPTY, not guessed
    expect(screen.getAllByText("Needs your input").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText(/^Locality in Vadodara/)).toHaveValue("");
    expect(screen.getByLabelText(/^Amount/)).toHaveValue("");
    const update = screen.getByRole("button", { name: "Update draft" });
    expect(update).toBeDisabled();

    await user.type(screen.getByLabelText("Which locality in Vadodara is the work in?"), "Alkapuri");
    await user.type(screen.getByLabelText("How much will you pay each worker (in rupees)?"), "800 per person");
    await user.click(update);

    await waitFor(() => expect(f.callsTo("POST /api/ai/job-draft")).toHaveLength(2));
    expect(f.callsTo("POST /api/ai/job-draft")[1]?.body).toEqual({
      text: "Need 8 helpers for a wedding tomorrow 5 PM to midnight",
      answers: [
        { question: "Which locality in Vadodara is the work in?", answer: "Alkapuri" },
        { question: "How much will you pay each worker (in rupees)?", answer: "800 per person" },
      ],
    });
    await waitFor(() => expect(screen.queryByText("A few details are missing or unclear")).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^Amount/)).toHaveValue("800");
  });

  it("still blocks publishing an incomplete draft even after confirmation (the form validates)", async () => {
    const incomplete = readyDraft({ draft: { ...readyDraft().draft, pay_amount_paise: null }, questions: [{ field: "pay_amount", question: "How much will you pay each worker (in rupees)?" }], ready: false, missing_fields: ["pay_amount"] });
    const f = installFetch({ ...baseRoutes("employer"), "POST /api/ai/job-draft": { json: incomplete } });
    renderApp("/employer/jobs/new/ai");
    const user = await draftFrom(WEDDING);
    await screen.findByText("Your draft is ready to check");
    await user.click(screen.getByRole("checkbox", { name: /I've checked these details/ }));
    await user.click(screen.getByRole("button", { name: "Publish job" }));
    expect(await screen.findByText(/enter the pay in rupees/i)).toBeInTheDocument();
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0);
  });

  it("explains clearly when AI is not configured, and keeps the standard form one click away", async () => {
    installFetch({ ...baseRoutes("employer"), "GET /api/ai/status": { json: { available: false } } });
    renderApp("/employer/jobs/new/ai");
    expect(await screen.findByText("AI job creation isn't switched on here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "use the standard form" })).toHaveAttribute("href", "/employer/jobs/new");
    await userEvent.setup().type(screen.getByLabelText(/^Describe the job/), WEDDING);
    expect(screen.getByRole("button", { name: "Create draft" })).toBeDisabled();
  });

  it.each([
    ["ai_not_configured", 503, /isn't set up on this server yet/],
    ["ai_unavailable", 503, /isn't reachable right now/],
    ["ai_busy", 429, /busy/],
    ["ai_rate_limited", 429, /used the assistant a lot/],
    ["ai_invalid_response", 502, /couldn't be read/],
    ["ai_declined", 422, /Rephrase it/],
  ])("handles the '%s' failure gracefully and keeps what was typed", async (code, status, help) => {
    installFetch({ ...baseRoutes("employer"), "POST /api/ai/job-draft": { status, json: { error: { code, message: "AI problem." } } } });
    renderApp("/employer/jobs/new/ai");
    await draftFrom(WEDDING);
    expect(await screen.findByRole("alert")).toHaveTextContent("AI problem.");
    expect(screen.getByText(help)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Describe the job/)).toHaveValue(WEDDING);
    expect(screen.getByRole("link", { name: "Prefer the standard form?" })).toBeInTheDocument();
  });

  it("fills the box from an example, and from voice, and the transcript stays editable before sending", async () => {
    installSpeech();
    const f = installFetch({ ...baseRoutes("employer"), "POST /api/ai/job-draft": { json: readyDraft() } });
    renderApp("/employer/jobs/new/ai");
    const user = userEvent.setup();
    const box = await screen.findByLabelText(/^Describe the job/);

    await user.click(screen.getByRole("button", { name: /Two people to load and unload a tempo/ }));
    expect((box as HTMLTextAreaElement).value).toContain("load and unload a tempo");
    await user.clear(box);

    await user.click(screen.getByRole("button", { name: "Speak" }));
    act(() => lastRec().say("I need eight helpers for a wedding in Alkapuri", true));
    expect(box).toHaveValue("I need eight helpers for a wedding in Alkapuri");
    expect(f.callsTo("POST /api/ai/job-draft")).toHaveLength(0); // speaking does not send anything

    // the organiser fixes what the microphone heard, then sends
    await user.type(box, " tomorrow 5 PM to midnight, 800 rupees each");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText("Your draft is ready to check");
    expect(f.callsTo("POST /api/ai/job-draft")[0]?.body.text).toBe("I need eight helpers for a wedding in Alkapuri tomorrow 5 PM to midnight, 800 rupees each");
  });

  it("works without voice support: typing is all that's needed", async () => {
    installFetch({ ...baseRoutes("employer"), "POST /api/ai/job-draft": { json: readyDraft() } });
    renderApp("/employer/jobs/new/ai");
    await screen.findByLabelText(/^Describe the job/);
    expect(screen.queryByRole("button", { name: "Speak" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Type your request instead/);
    await draftFrom(WEDDING);
    expect(await screen.findByText("Your draft is ready to check")).toBeInTheDocument();
  });

  it("is only for employers", async () => {
    fakeSupabase.reset();
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    renderApp("/employer/jobs/new/ai");
    expect(await screen.findByRole("heading", { name: "Find work" })).toBeInTheDocument();
  });
});

// ----------------------------------------------------------------- worker voice search
describe("worker voice and text search", () => {
  const sofa = job();
  const wedding = job({ id: "44444444-4444-4444-8444-444444444444", title: "Wedding helpers", category_id: 2, locality_id: 1, starts_at: "2099-11-26T11:30:00+00:00", ends_at: "2099-11-26T18:30:00+00:00" });
  beforeEach(() => signInAs("worker"));

  it("interprets the request, shows it for editing, and only searches after confirmation", async () => {
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": { json: { jobs: [sofa, wedding], page: { limit: 20, offset: 0 } } },
      "GET /api/me/bookings": { json: { bookings: [] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Shift household goods" });
    await user.type(screen.getByLabelText("What are you looking for?"), "Show me cleaning jobs near Gotri tomorrow");
    await user.click(screen.getByRole("button", { name: "Understand my request" }));

    const group = await screen.findByRole("group", { name: "What I understood" });
    expect(within(group).getByText(/Cleaning jobs in Gotri tomorrow/)).toBeInTheDocument();
    expect(within(group).getByLabelText("Type of work")).toHaveValue("2");
    expect(within(group).getByLabelText("Locality")).toHaveValue("2");
    expect(within(group).getByLabelText("Date")).not.toHaveValue("");
    const before = f.callsTo("GET /api/jobs").length;

    // edit what was understood, then confirm
    await user.selectOptions(within(group).getByLabelText("Locality"), "1");
    await user.click(within(group).getByRole("button", { name: "Show these jobs" }));
    await waitFor(() => expect(f.callsTo("GET /api/jobs").length).toBeGreaterThan(before));
    const last = f.callsTo("GET /api/jobs").at(-1)!;
    expect(last.search).toContain("category_id=2");
    expect(last.search).toContain("locality_id=1"); // the edit won
    expect(screen.queryByRole("group", { name: "What I understood" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Date", { selector: "#" + (screen.getAllByLabelText("Date").at(-1) as HTMLElement).id })).not.toHaveValue("");
  });

  it("runs a fresh search every time 'Show these jobs' is clicked, even if the filters are unchanged", async () => {
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": { json: { jobs: [sofa, wedding], page: { limit: 20, offset: 0 } } },
      "GET /api/me/bookings": { json: { bookings: [] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Shift household goods" });
    for (let i = 0; i < 2; i++) {
      await user.clear(screen.getByLabelText("What are you looking for?"));
      await user.type(screen.getByLabelText("What are you looking for?"), "cleaning jobs near Gotri");
      await user.click(screen.getByRole("button", { name: "Understand my request" }));
      const group = await screen.findByRole("group", { name: "What I understood" });
      const before = f.callsTo("GET /api/jobs").length;
      await user.click(within(group).getByRole("button", { name: "Show these jobs" }));
      await waitFor(() => expect(f.callsTo("GET /api/jobs").length).toBeGreaterThan(before));
    }
  });

  it("says so honestly when it couldn't understand, instead of guessing", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": { json: { jobs: [sofa], page: { limit: 20, offset: 0 } } }, "GET /api/me/bookings": { json: { bookings: [] } }, "GET /api/me/applications": { json: { applications: [] } } });
    renderApp("/worker");
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Shift household goods" });
    await user.type(screen.getByLabelText("What are you looking for?"), "um please show me the jobs");
    await user.click(screen.getByRole("button", { name: "Understand my request" }));
    expect(await screen.findByText(/couldn't pick out a type of work, place or day/)).toBeInTheDocument();
  });

  it("takes a spoken request through the same confirm step", async () => {
    installSpeech();
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": { json: { jobs: [sofa], page: { limit: 20, offset: 0 } } }, "GET /api/me/bookings": { json: { bookings: [] } }, "GET /api/me/applications": { json: { applications: [] } } });
    renderApp("/worker");
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Shift household goods" });
    await user.click(screen.getAllByRole("button", { name: "Speak" })[0]!);
    act(() => lastRec().say("show me event helper jobs near Alkapuri", true));
    expect(screen.getByLabelText("What are you looking for?")).toHaveValue("show me event helper jobs near Alkapuri");
    await user.click(screen.getByRole("button", { name: "Understand my request" }));
    const group = await screen.findByRole("group", { name: "What I understood" });
    expect(within(group).getByLabelText("Locality")).toHaveValue("1");
  });

  it("filters by date (IST) on the server", async () => {
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": ({ url }) => ({ json: { jobs: url.searchParams.get("date_from") === "2099-11-26" ? [wedding] : [sofa, wedding], page: { limit: 20, offset: 0 } } }),
      "GET /api/me/bookings": { json: { bookings: [] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const date = screen.getAllByLabelText("Date").find((el) => el.closest("form")?.getAttribute("aria-label") === "Filter jobs")!;
    fireEvent.change(date, { target: { value: "2099-11-26" } });
    expect(await screen.findByRole("link", { name: "Wedding helpers" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Shift household goods" })).not.toBeInTheDocument());
    const last = new URLSearchParams(f.callsTo("GET /api/jobs").at(-1)!.search);
    expect([last.get("date_from"), last.get("date_to")]).toEqual(["2099-11-26", "2099-11-26"]);
  });
});

// ------------------------------------------------------------------- worker dashboard
describe("worker dashboard summary", () => {
  beforeEach(() => signInAs("worker"));

  it("shows profile completeness, upcoming confirmed jobs and application counts from real data", async () => {
    const j = job();
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } },
      "GET /api/me/contact": { json: { phone: "+919876543210" } },
      "GET /api/me/bookings": {
        json: {
          bookings: [
            { id: "b1", job_id: j.id, application_id: "a1", worker_id: "w", employer_id: j.employer_id, agreed_pay_paise: 85000, status: "confirmed", cancelled_by: null, cancelled_at: null, cancel_reason: null, completed_at: null, created_at: "2026-11-20T00:00:00Z", job: j },
            { id: "b2", job_id: j.id, application_id: "a2", worker_id: "w", employer_id: j.employer_id, agreed_pay_paise: 85000, status: "cancelled_by_worker", cancelled_by: "w", cancelled_at: "2026-11-20T00:00:00Z", cancel_reason: null, completed_at: null, created_at: "2026-11-20T00:00:00Z", job: { ...j, title: "Cancelled one" } },
          ],
        },
      },
      "GET /api/me/applications": {
        json: {
          applications: [
            { id: "a1", job_id: j.id, worker_id: "w", status: "accepted", status_reason: null, message: null, decided_at: "x", created_at: "2026-11-20T00:00:00Z" },
            { id: "a2", job_id: j.id, worker_id: "w", status: "pending", status_reason: null, message: null, decided_at: null, created_at: "2026-11-20T00:00:00Z" },
            { id: "a3", job_id: j.id, worker_id: "w", status: "pending", status_reason: null, message: null, decided_at: null, created_at: "2026-11-20T00:00:00Z" },
            { id: "a4", job_id: j.id, worker_id: "w", status: "rejected", status_reason: "job_filled", message: null, decided_at: "x", created_at: "2026-11-20T00:00:00Z" },
          ],
        },
      },
    });
    renderApp("/worker");
    const overview = await screen.findByRole("region", { name: "Your overview" });
    await within(overview).findByText("Shift household goods"); // upcoming confirmed booking
    expect(within(overview).queryByText("Cancelled one")).not.toBeInTheDocument(); // cancelled bookings are not "upcoming"
    expect(await within(overview).findByText(/Profile \d+% complete/)).toBeInTheDocument();
    const text = overview.textContent ?? "";
    expect(text).toMatch(/2\s*waiting for the employer/);
    expect(text).toMatch(/1\s*accepted/);
    expect(text).toMatch(/1\s*not selected/);
    expect(within(overview).getByRole("progressbar", { name: "Profile completeness" })).toHaveAttribute("aria-valuenow");
  });

  it("scores completeness from what the worker actually provided, never counting missing data as done", async () => {
    const bare = meFor("worker", { worker: { locality_id: null, category_ids: [], is_available: true } });
    installFetch({
      ...baseRoutes("worker", bare),
      "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } },
      "GET /api/me/bookings": { json: { bookings: [] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    const overview = await screen.findByRole("region", { name: "Your overview" });
    expect(await within(overview).findByText("Profile 0% complete")).toBeInTheDocument();
    expect(within(overview).getByText(/No confirmed jobs yet/)).toBeInTheDocument();
    expect(within(overview).getByText(/haven't applied yet/)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------ category photos
describe("category images", () => {
  it("uses the locally stored photograph for a category, as a decorative image with dimensions", () => {
    const { container } = render(<CategoryImage slug="event_help" name="Event help" />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/images/cat-event.jpg");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("width");
    expect(img).toHaveAttribute("height");
  });

  it("falls back to a coloured tile instead of a broken image when the photo can't load", () => {
    const { container } = render(<CategoryImage slug="cleaning" name="Cleaning" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("C");
  });

  it("uses a tile for a category with no photo mapping", () => {
    const { container } = render(<CategoryImage slug="something_new" name="Welding" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("W");
  });
});
