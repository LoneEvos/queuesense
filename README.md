# QueueSense

APU bus queue intelligence. NFC sticker → phone opens `/t/{tag_id}` → ingest → Firestore live count (+ history) → `/live` on every screen.
Rules for contributors and AI assistants: [CLAUDE.md](CLAUDE.md). Source of truth: Project Context page in Notion.

## Status

| Part | State |
| --- | --- |
| `/web` NFC simulator `/sim` | Built. Virtual stickers with real NTAG213 NDEF bytes + a virtual phone |
| `/web` tap page `/t/:tagId` | Built. Anonymous auth, offline store-and-forward, shows your place (#21, about 1 min) and updates live |
| `/web` live count `/` and `/live/:stopId` | Built. Queue length, wait estimate, last bus (boarded / left behind), real-time |
| `/ingest` | Built. Token check, tag registry, anti-spoof rules, salted hash, live queue + history in one Firestore transaction |
| `/simulator` | `send-tap.js`, `rush.js` (200-500 student rush hour), `watch-live.js` |
| `/simulator/history.js` | Built. 6 weeks of SIMULATED history (journeys, trips, queue snapshots) for BigQuery: `npm run history` |
| `/sql` | Built. BigQuery sandbox views + BigQuery ML ARIMA_PLUS demand forecast. See [sql/README.md](sql/README.md) |
| `/dispatch` | Built. KPIs, wait heatmap, 7-day forecast vs seats (today onwards), bus recommendations, what-if slider, AI summary. History is simulated; real taps feed the live count but are not yet exported to BigQuery |
| `/insights` | Built. Recommender (`recommend.js`) and Gemini summary (`gemini.js`, optional key, template fallback). See [insights/README.md](insights/README.md) |

`SIMULATION_MODE=true` (default) stamps `simulated: true` on every event. Set it to `false` once real taps count.

Tested locally: 500 students joined in 18 s, 13 buses boarded, 1,013 taps, 0 failures, every count correct.

## Run it locally (free, simulated NFC)

Needs Node 22 and Java 11+ (for the Firestore emulator). No cloud account or billing.

```bash
npm run setup
npm run dev
```

- http://localhost:5173/ is the **live count**.
- http://localhost:5173/sim is the **NFC simulator**: tap a virtual sticker and the virtual phone opens the tap page.
- `npm run rush` (second terminal) sends a 300-student rush hour. Options: `npm run rush -- --students 500 --bus 40`.
- `npm run tap -- stopA-q1 bus01-door1 --students 3` sends individual taps.
- http://localhost:5173/dispatch is the **dispatcher dashboard** (simulated history from `sql/dispatch-snapshot.json`). Add `GEMINI_API_KEY` to `ingest/.env.local` for the Gemini summary.

Phone on the same Wi-Fi: open `http://<your-PC-IP>:5173/sim`. The app calls `/api` through the Vite proxy, so no extra config.

## Live deployment (free tier)

- **Site:** https://queuesense-one.vercel.app (live count), `/sim` (NFC simulator), `/dispatch` (dashboard), `/t/{tag_id}` (sticker taps). The original deployment, queuesense-coral.vercel.app, runs an older version from the upstream repo.
- **Vercel (Hobby), Services:** `web` (Vite) serves every page; `api` (`api/index.js`, Express, region `sin1`) serves `/api/*`. See `vercel.json`. Auto-deploys on every push to `main`.
- **Firebase `queuesense-apu` (Spark):** Anonymous Auth, Firestore `asia-southeast1`, rules from `firestore.rules`. Web config in `web/.env.production`.
- **BigQuery sandbox:** dataset `queuesense`, see [sql/README.md](sql/README.md). The forecast covers 14 days from the last history day; the dashboard shows today onwards and warns when it runs out.
- **Secrets, set in Vercel only (never commit them):**
  - `FIREBASE_SERVICE_ACCOUNT` (required) = the Firebase service account JSON (Project settings → Service accounts → Generate new private key). Also used for BigQuery.
  - `GEMINI_API_KEY` (optional) = free key from Google AI Studio for the AI summary on `/dispatch`; without it a template summary is shown. `GEMINI_MODEL` optionally overrides the model list.
  - `HASH_SALT` (optional) = by default derived from the service account key. If two deployments share one Firestore, set the same value on both so a student gets the same anonymous ID on each.
- **Stickers:** write the URLs in [tags/tags.csv](tags/tags.csv) (queuesense-one) with NFC Tools (Add record → URL). Stickers written earlier point to queuesense-coral; rewrite them. Tags seed into Firestore automatically on the first tap.

## Notes

`npm run dev` sets this already. Running the Firestore emulator by hand on Windows needs a short Java socket temp dir:
```bash
JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/Users/Public/qs-jtmp" npx firebase-tools emulators:start --only auth,firestore --project demo-queuesense
```
