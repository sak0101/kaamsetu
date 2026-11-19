import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAuth } from "../lib/auth";
import { Button } from "./ui";

// Minimal typings for the Web Speech API (not in every TypeScript DOM lib).
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechAlternative;
  length: number;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

export function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechLang = "en-IN" | "hi-IN" | "gu-IN";
export const SPEECH_LANGUAGES: { code: SpeechLang; label: string }[] = [
  { code: "en-IN", label: "English" },
  { code: "hi-IN", label: "हिन्दी (Hindi)" },
  { code: "gu-IN", label: "ગુજરાતી (Gujarati)" },
];
/** The speaking language that matches the user's saved language (English when none). */
export const speechLangFor = (preferred: "en" | "hi" | "gu" | undefined): SpeechLang => (preferred === "hi" ? "hi-IN" : preferred === "gu" ? "gu-IN" : "en-IN");

export function describeSpeechError(code: string): string {
  switch (code) {
    case "language-not-supported":
      return "This browser can't recognise that language by voice. Choose another language, or just type instead.";
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it in your browser's address bar, or just type instead.";
    case "no-speech":
      return "I didn't hear anything. Tap the microphone and try again, or type instead.";
    case "audio-capture":
      return "No microphone was found. You can type instead.";
    case "network":
      return "The browser's speech service couldn't be reached. You can type instead.";
    case "aborted":
      return "";
    default:
      return "Voice input didn't work this time. You can type instead.";
  }
}

/**
 * Push-to-talk voice input. It listens ONLY while the user has pressed the button
 * (one utterance at a time, never continuously and never in the background), shows
 * a live "Listening" indicator, and hands the recognised text to the parent, which
 * puts it in an editable field. Where speech recognition isn't available, or the
 * microphone is blocked, it says so and the typed input keeps working.
 */
export function VoiceInput({
  onText,
  label = "Speak",
  disabled = false,
}: {
  /** Receives each final recognised phrase. The parent appends it to an editable field. */
  onText: (text: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const Ctor = getRecognitionCtor();
  const me = useOptionalAuth()?.me ?? null;
  // Which language to listen for. Starts from the user's saved language; they can change it per request.
  const [lang, setLang] = useState<SpeechLang>(() => speechLangFor(me?.profile.preferred_language));
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const recRef = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  // Never keep listening after the component goes away.
  useEffect(
    () => () => {
      recRef.current?.abort();
      recRef.current = null;
    },
    [],
  );

  if (!Ctor) {
    return (
      <p className="text-sm text-ink-soft" role="note">
        Voice input isn't available in this browser. Type your request instead. (Chrome and Edge support voice.)
      </p>
    );
  }

  function start() {
    if (!Ctor || listening) return;
    setError("");
    setInterim("");
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript;
        if (r.isFinal) onTextRef.current(text.trim());
        else live += text;
      }
      setInterim(live);
    };
    rec.onerror = (e) => {
      setError(describeSpeechError(e.error));
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      setInterim("");
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      setError(describeSpeechError("other"));
      recRef.current = null;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {listening ? (
          <Button variant="danger" onClick={stop} aria-label="Stop listening">
            <span aria-hidden="true">■</span> Stop
          </Button>
        ) : (
          <Button variant="secondary" onClick={start} disabled={disabled} aria-label={label}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
            </svg>
            {label}
          </Button>
        )}
        <label className="flex items-center gap-2 text-sm">
          <span className="font-semibold">Speak in</span>
          <select
            value={lang}
            disabled={listening}
            onChange={(e) => setLang(e.target.value as SpeechLang)}
            className="min-h-11 rounded-lg border-2 border-line bg-white px-2 text-base text-ink"
            aria-label="Speaking language"
          >
            {SPEECH_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
        <span role="status" aria-live="polite" className="text-sm font-semibold">
          {listening && (
            <span className="inline-flex items-center gap-2 text-danger-dark">
              <span aria-hidden="true" className="inline-block h-3 w-3 animate-pulse rounded-full bg-danger" />
              Listening… speak now
            </span>
          )}
        </span>
      </div>
      {interim && <p className="text-sm italic text-ink-soft">“{interim}”</p>}
      {error && (
        <p role="alert" className="text-sm font-semibold text-danger-dark">
          {error}
        </p>
      )}
    </div>
  );
}
