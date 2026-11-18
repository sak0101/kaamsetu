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

`apps/api/src/fit.ts`. Weights: type of work 0.30, locality 0.20, experience 0.10. **Missing locality or experience is excluded and the remaining weights renormalised**, never treated as zero; an explicit "0 years" is real data. Reviews, attendance and reliability are **not used** because none exist. `completed_jobs` is a real count from bookings (0 for new workers) and is shown, not scored. An overlapping booking is a flag that sorts a worker last without changing the percentage. The card says why, in plain words, and the employer decides.

## Photos

Eight locally stored photographs in `apps/web/public/images/` from Wikimedia Commons under CC BY / CC BY-SA, with `credits.json` and a public `/credits` page linked from the footers. Tests check every referenced file exists, is a valid JPEG, is under 400 KB and is credited under an allowed licence. Missing photos (packing, shop) fall back to a coloured tile, never a broken image.

## Verifying locally

```
npx supabase start -x studio,imgproxy,postgres-meta,edge-runtime,logflare,vector,supavisor,storage-api   # includes Mailpit
npx supabase db reset --local && npx supabase test db            # pgTAP
node supabase/tests/concurrency/run.mjs                            # race tests
npm test                                                           # unit tests (api + web)
npm run test:integration -w @kaamsetu/api                          # real Express + real database
npm run e2e -w @kaamsetu/web                                       # real Edge browser, both roles, AI via local stub
```
