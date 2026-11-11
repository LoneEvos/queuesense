# /insights

- `recommend.js`: bus deployment recommender. Replays the forecast through the timetable and picks the extra buses that save the most waiting. Pure and deterministic; the dashboard numbers come from here.
- `gemini.js`: the AI summary on `/dispatch` (`GET /api/insights`). Server-side only.

## How the Gemini summary works

1. `buildFacts()` takes the dashboard data and keeps only aggregates (KPIs, longest and shortest waits, worst left-behind days, the 7-day forecast peaks, the top 3 recommendations). No IDs, no per-person rows. All of it is SIMULATED.
2. `askGemini()` sends those facts to the Gemini API (REST, no SDK) and asks for JSON: `headline`, `points`, `action`. The prompt tells it to copy numbers, not compute new ones.
3. `uncheckedNumbers()` checks every number in the answer against the facts. Anything not found shows on the dashboard as "Check before acting".
4. No key, a timeout (15 s) or any error: `templateSummary()` writes the same summary from a fixed template, so the demo never breaks.

The answer is cached in memory for 1 hour (5 min after a failure) and on the Vercel CDN, so the free-tier quota is not a concern.

## Turn it on (free, no billing)

1. Create a key at https://aistudio.google.com/apikey (Gemini API free tier).
2. Local: put `GEMINI_API_KEY=...` in `ingest/.env.local` (gitignored), then restart `npm run dev`.
3. Vercel: Project → Settings → Environment Variables → `GEMINI_API_KEY`, then redeploy.
4. Optional: `GEMINI_MODEL` (default `gemini-flash-latest`, Google's alias for the current Flash model).

The free tier lets Google use prompts to improve its products. We only send simulated aggregates, so nothing personal leaves the server.

Never commit the key or put it in `web/` (anything there reaches the browser).
