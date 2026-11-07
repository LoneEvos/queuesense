# QueueSense

APU bus queue intelligence. NFC sticker → phone opens `/t/{tag_id}` → ingest → Firestore live count (+ history) → `/live` on every screen.
Rules for contributors and AI assistants: [CLAUDE.md](CLAUDE.md). Source of truth: Project Context page in Notion.

## Status

| Part | State |
| --- | --- |
| `/web` NFC simulator `/` | Built. Virtual stickers with real NTAG213 NDEF bytes + a virtual phone |
| `/web` tap page `/t/:tagId` | Built. Anonymous auth, offline store-and-forward, shows your place (#21, about 1 min) and updates live |
| `/web` live count `/live/:stopId` | Built. Queue length, wait estimate, last bus (boarded / left behind), real-time |
| `/ingest` | Built. Token check, tag registry, anti-spoof rules, salted hash, live queue + history in one Firestore transaction |
| `/simulator` | `send-tap.js`, `rush.js` (200-500 student rush hour), `watch-live.js` |
| `/dispatch`, `/sql` (BigQuery forecast), `/insights` (Gemini) | Not built yet |

`SIMULATION_MODE=true` (default) stamps `simulated: true` on every event. Set it to `false` once real taps count.

Tested locally: 500 students joined in 18 s, 13 buses boarded, 1,013 taps, 0 failures, every count correct.

## Run it locally (free, simulated NFC)

Needs Node 20+ and Java 11+ (for the Firestore emulator). No cloud account or billing.

```bash
npm run setup
npm run dev
```

- http://localhost:5173/ is the **NFC simulator**: tap a virtual sticker and the virtual phone opens the tap page.
- http://localhost:5173/live/stopA is the **live count**.
- `npm run rush` (second terminal) sends a 300-student rush hour. Options: `npm run rush -- --students 500 --bus 40`.
- `npm run tap -- stopA-q1 bus01-door1 --students 3` sends individual taps.

Phone on the same Wi-Fi: open `http://<your-PC-IP>:5173/`. Set `VITE_INGEST_URL=http://<your-PC-IP>:8081` in `web/.env.local` and add `http://<your-PC-IP>:5173` to `ALLOWED_ORIGINS` in `ingest/.env.local`.

## Later: deploy (free tier, when the stickers arrive)

- **Firebase (Spark, free):** Anonymous Auth + Firestore. Deploy `firestore.rules`.
- **Vercel (free):** the web app, and ingest as one serverless function. Salt as a Vercel env var.
- **BigQuery sandbox (free):** history and forecast.
- Sticker URLs become `https://<vercel-domain>/t/{tag_id}`. Fill them into [tags/tags.csv](tags/tags.csv), then write each with NFC Tools (Add record → URL).

## Notes

`npm run dev` sets this already. Running the Firestore emulator by hand on Windows needs a short Java socket temp dir:
```bash
JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/Users/Public/qs-jtmp" npx firebase-tools emulators:start --only auth,firestore --project demo-queuesense
```
