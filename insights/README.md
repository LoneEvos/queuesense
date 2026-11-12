# /insights

- `recommend.js`: bus deployment recommender. Replays the forecast through the timetable and picks the extra buses that save the most waiting. Pure and deterministic; the dashboard numbers come from here.
- `gemini.js`: the AI summary on `/dispatch` (`GET /api/insights`): facts, prompt, JSON validation, template, cache. Server-side only.
- `ai-provider.js`: the only code that calls a model. `AI_PROVIDER` picks the backend. To swap in another Gemini endpoint (e.g. Gemini Enterprise), change only this file.

## How the AI summary works

1. `buildFacts()` takes the dashboard data and keeps only aggregates (KPIs, longest and shortest waits, worst left-behind days, the 7-day forecast peaks, the top 3 recommendations). No IDs, no per-person rows. All of it is SIMULATED.
2. `generateJson()` in `ai-provider.js` sends those facts with a JSON schema. The answer must be: `summary` (3 sentences for APU management), `actions` (exactly 3, each with `action` and `reason`), `caveat` (1 sentence). The prompt tells the model to copy numbers, not compute new ones.
3. `validateSummary()` checks the JSON strictly (2-4 sentences, 3 actions with reasons, a caveat). An invalid answer counts as a failure and the next model is tried.
4. `uncheckedNumbers()` checks every number against the facts. Anything not found shows on the dashboard as "Check before acting".
5. Provider set to `template`, not configured, every model failing, or 50 s passing: `templateSummary()` writes the same shape from a fixed template, so the demo never breaks. The card's badge says GEMINI or TEMPLATE FALLBACK.

The answer is cached in memory for 1 hour (5 min after a failure) and on the Vercel CDN (`s-maxage`), so page loads do not call the model.

## Providers (`AI_PROVIDER`)

| Value | What it calls | Env vars |
|---|---|---|
| `gemini-api` | Gemini API, Google AI Studio key (free tier, no billing) | `GEMINI_API_KEY`, optional `GEMINI_MODEL` |
| `vertex` | Gemini on Vertex AI (Google Cloud; the project needs the Vertex AI API, which needs billing) | `VERTEX_PROJECT`, `VERTEX_LOCATION` (default `global`), `VERTEX_SERVICE_ACCOUNT` (default `FIREBASE_SERVICE_ACCOUNT`), optional `GEMINI_MODEL` |
| `template` | Nothing; fixed summary | none |

Unset: `gemini-api` if `GEMINI_API_KEY` is set, otherwise `template`.
`GEMINI_MODEL` is one model or a comma-separated list tried in order. Default: `gemini-3.6-flash`, `gemini-3.1-flash-lite`, `gemini-flash-lite-latest`, `gemini-3.5-flash-lite`, `gemini-3.7-flash`. It moves on after an overload, rate limit, missing model, invalid answer or 25 s without an answer; all attempts together stop at 50 s.

## Turn it on (free, no billing)

1. Create a key at https://aistudio.google.com/apikey (Gemini API free tier).
2. Local: put `GEMINI_API_KEY=...` in `ingest/.env.local` (gitignored), then restart `npm run dev`.
3. Vercel: Project → Settings → Environment Variables → `GEMINI_API_KEY`, then redeploy.

The free tier lets Google use prompts to improve its products. We only send simulated aggregates, so nothing personal leaves the server.

Never commit the key or put it in `web/` (anything there reaches the browser).
