import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInput, speechLangFor } from "../components/VoiceInput";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, meFor, renderApp, signInAs } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

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
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {}
}
const last = () => FakeRecognition.instances.at(-1)!;

beforeEach(() => {
  fakeSupabase.reset();
  FakeRecognition.instances = [];
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
});
afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  vi.unstubAllGlobals();
});

describe("voice language selection", () => {
  it("maps the saved language to a speech language", () => {
    expect(speechLangFor("en")).toBe("en-IN");
    expect(speechLangFor("hi")).toBe("hi-IN");
    expect(speechLangFor("gu")).toBe("gu-IN");
    expect(speechLangFor(undefined)).toBe("en-IN");
  });

  it("offers English, Hindi and Gujarati, defaulting to English outside an account", async () => {
    render(<VoiceInput onText={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Speaking language" }) as HTMLSelectElement;
    expect(select.value).toBe("en-IN");
    expect([...select.options].map((o) => o.value)).toEqual(["en-IN", "hi-IN", "gu-IN"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    expect(last().lang).toBe("en-IN");
  });

  it("listens in the language the user picks, and only starts when the button is pressed", async () => {
    render(<VoiceInput onText={() => {}} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Speaking language" }), "hi-IN");
    expect(FakeRecognition.instances).toHaveLength(0); // choosing a language does not start the microphone
    await user.click(screen.getByRole("button", { name: "Speak" }));
    expect(last().lang).toBe("hi-IN");
    await user.click(screen.getByRole("button", { name: "Stop listening" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Speaking language" }), "gu-IN");
    await user.click(screen.getByRole("button", { name: "Speak" }));
    expect(last().lang).toBe("gu-IN");
  });

  it("cannot be changed while listening", async () => {
    render(<VoiceInput onText={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    expect(screen.getByRole("combobox", { name: "Speaking language" })).toBeDisabled();
  });

  it("starts from the user's saved language", async () => {
    signInAs("worker");
    const me = meFor("worker");
    installFetch({
      ...baseRoutes("worker", { ...me, profile: { ...me.profile, preferred_language: "gu" } }),
      "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } },
      "GET /api/me/bookings": { json: { bookings: [] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    const select = await screen.findByRole("combobox", { name: "Speaking language" });
    expect((select as HTMLSelectElement).value).toBe("gu-IN");
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Speak" })[0]!);
    expect(last().lang).toBe("gu-IN");
  });

  it("explains an unsupported language and keeps typing available", async () => {
    const onText = vi.fn();
    render(
      <>
        <VoiceInput onText={onText} />
        <label>
          Typed request
          <input />
        </label>
      </>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Speak" }));
    act(() => last().onerror?.({ error: "language-not-supported" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't recognise that language by voice.*type instead/);
    expect(screen.getByLabelText("Typed request")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Speak" })).toBeEnabled(); // and they can pick another language and retry
  });

  it("without any speech support there is no language picker, just the typing message", () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    render(<VoiceInput onText={() => {}} />);
    expect(screen.queryByRole("combobox", { name: "Speaking language" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Type your request instead/);
  });
});
