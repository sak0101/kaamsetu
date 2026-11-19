# AI job creation, voice, applicant fit, photos

## AI job creation ("Create a job with AI")

- Route: `POST /api/ai/job-draft` (employers only). The browser never talks to Anthropic and never sees the key.
- Needs **`ANTHROPIC_API_KEY`** in the server environment (GoDaddy env settings in production). `ANTHROPIC_MODEL` is optional (default `claude-opus-5-5`). Claude Code's own login is not an application key. Without a key the endpoint answers `503 ai_not_configured`, the UI says so and points to the standard form, and nothing else is affected.
- How it works (`apps/api/src/ai.ts`): the model gets today's IST date, the **real** category and locality lists (output is constrained to them with enums), and the organiser's text inside delimiters as *data*. It returns structured JSON (`output_config.format` + Zod). The server then **re-validates everything itself** (dates not in the past, 1–50 workers, ₹1–₹50,000, valid HH:MM, overnight shifts flagged, unknown category/locality dropped) and decides what is "ready". Missing or doubtful values become follow-up questions; nothing is invented.
- **It never publishes.** The endpoint only returns a draft. The UI shows an editable preview, flags each field as *Filled by AI* / *Assumed* / *Needs your input*, lists the assumptions, and the **Publish** button stays locked until the organiser ticks an explicit confirmation. Publishing is the ordinary `POST /api/jobs`.
- Safety: Claude refusals → `ai_declined`; unreadable output → `ai_invalid_response`; SDK/network errors → generic `ai_unavailable`/`ai_busy` (no provider text or key ever returned); per-user limit of 12 drafts per 10 minutes (in-memory, exact on GoDaddy's single process).
- Tests: unit (`ai.test.ts`, SDK injected), HTTP (`ai.test.ts` routes), real-stack (`extras.integration.test.ts`), browser E2E through a local **stub** of the Anthropic API (`apps/web/e2e/anthropic-stub.mjs`, validates the request shape; NOT Claude), and an **opt-in live test** (`ai.live.test.ts`: `RUN_LIVE_AI_TESTS=1 ANTHROPIC_API_KEY=… npm test -w @kaamsetu/api -- ai.live`).

## Voice

- `components/VoiceInput.tsx` uses the browser's Web Speech API (Chrome/Edge). **Push-to-talk only**: it listens for one phrase after the user presses *Speak*, shows a live "Listening…" indicator and interim text, stops when the phrase ends, and aborts on unmount. The transcript lands in an editable box; nothing is sent until the user acts.
- Unsupported browsers or blocked microphones get a plain message and the typed input keeps working.
- Organiser: the transcript feeds "Create a job with AI". Worker: "Ask in your own words" → a rule-based parser (`lib/voiceQuery.ts`, no AI call) turns "event helper jobs near Alkapuri tomorrow" into category + locality + date + keywords, shows what it understood in **editable controls**, and searches only after the worker confirms.

## Applicant fit (explanation, not a quality score)

`apps/api/src/fit.ts`. Weights: type of work 0.30, locality 0.20, experience 0.10. **Missing locality or experience is excluded and the remaining weights renormalised**, never treated as zero; an explicit "0 years" is real data. Reviews and no-shows (from completed bookings, migration 15) are shown as plain facts but are **never part of the percentage**, so having none costs nothing. `completed_jobs` is a real count from bookings (0 for new workers) and is shown, not scored. An overlapping booking is a flag that sorts a worker last without changing the percentage. The card says why, in plain words, and the employer decides.

## Photos

Superseded: there are no longer any photographs. See "Pictures" below (one consistent set of original illustrations); `/credits` explains this and would list any third-party photograph that is ever added.

## Verifying locally

```
npx supabase start -x studio,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor,storage-api   # includes Mailpit
npx supabase db reset --local && npx supabase test db            # pgTAP
node supabase/tests/concurrency/run.mjs                            # race tests
npm test                                                           # unit tests (api + web)
npm run test:integration -w @kaamsetu/api                          # real Express + real database
npm run e2e -w @kaamsetu/web                                       # real Edge browser, both roles, AI via local stub
```


## Languages (English, Hindi, Gujarati, Hinglish and mixed)

- **Job drafting** (`apps/api/src/ai.ts`): the prompt tells Claude to read all four ways of writing, to write the text the organiser will edit (title, description, assumptions, questions) in the language they used (their profile language breaks ties for mixed text), and to keep fixed values in English or digits (category and locality from the allowed lists, ISO dates, 24-hour times, numbers). Hindi and Gujarati category names are included in the prompt. Missing details stay missing and are asked about; the server still re-validates everything and the organiser must tick the confirmation before publishing.
- **Voice search** (`apps/web/src/lib/voiceQuery.ts`) is still rule-based (no AI): it now understands Hindi, Gujarati and Hinglish words for each type of work, days (`कल`, `કાલે`, `kal`, `aaj`, `parso`, weekday names), localities in Devanagari, Gujarati script and common Latin spellings, and Gujarati endings attached to words (`ગોત્રીમાં`).
- **Voice input** (`VoiceInput.tsx`) has a "Speak in" picker: English (`en-IN`), Hindi (`hi-IN`), Gujarati (`gu-IN`), defaulting to the user's saved language (set on the profile pages). It stays push-to-talk. If the browser cannot recognise a language it says so and typing still works. Support for `gu-IN` varies by browser.
- **Work-type names** are shown in the user's language from the existing `name_hi` / `name_gu` columns, falling back to English.
- **Native-speaker review is required** for the Hindi and Gujarati labels, keyword lists and place-name spellings before they are relied on.

## AI-assisted worker profile ("Describe yourself")

`POST /api/ai/worker-profile-draft` (worker only, rate limited with the other AI calls). The prompt forbids inventing or embellishing experience, years, qualifications, skills, equipment or availability; years only when a number is stated; the bio uses only facts given and no praise. The server validates the structured output (real category and locality lists, 0 to 60 years, 2 to 40 character skills, at most 8 skills and 5 categories, 120-character availability note), drops anything out of range and turns it into a question. The profile page shows "Here's what I understood" with guesses and missing details; **only after "Fill my profile with this" are fields copied into the form, each marked "Filled by AI: please check", and nothing is saved until the worker presses Save** (the ordinary profile endpoint). Manual entry is unchanged and is the fallback when the AI is off or fails. Limit of what is guaranteed: the AI cannot be proven never to add a claim; the prompt, the validation and the mandatory review are the controls.

## Pictures

Job cards and category cards use local files in `apps/web/public/images` (nothing is hotlinked), one per type of work:

- **Eight real photographs** (640x360, 16:9 JPEG), one per category (`cat-*.jpg`): five under the Unsplash License (loading & unloading, cleaning, construction helpers, painting helpers, gardening) and three under the Pexels License (event help, furniture shifting, packing). Photographer, source page and licence for each are in `public/images/credits.json` (shown on the Credits page) and `docs/image-attributions.md`. The five Unsplash photos are shot in India; the three Pexels photos are not shown to be (no location on their pages), which is noted in the credits.
- **Original SVG illustrations** remain only for the five kinds of event used on Event help *job* cards (wedding, catering, exhibition, religious, corporate: `event-*.svg`); the general Event help category card is a photograph.

The event kind is chosen from the job's own title and description by keyword rules (`lib/jobImage.ts`, multilingual) only for "Event help" jobs; there is no AI call and no network request. A missing file falls back to a coloured tile.
