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

- http://localhost:5173/ is the **live count**.
- http://localhost:5173/sim is the **NFC simulator**: tap a virtual sticker and the virtual phone opens the tap page.
- `npm run rush` (second terminal) sends a 300-student rush hour. Options: `npm run rush -- --students 500 --bus 40`.
- `npm run tap -- stopA-q1 bus01-door1 --students 3` sends individual taps.

Phone on the same Wi-Fi: open `http://<your-PC-IP>:5173/sim`. The app calls `/api` through the Vite proxy, so no extra config.

## Live deployment (free tier)

- **Site:** https://queuesense-coral.vercel.app (live count), `/sim` (NFC simulator), `/t/{tag_id}` (sticker taps)
- **Vercel (Hobby):** web app + `/api` ingest function (`api/index.js`, region `sin1`). Auto-deploys on every push to `main`.
- **Firebase `queuesense-apu` (Spark):** Anonymous Auth, Firestore `asia-southeast1`, rules from `firestore.rules`.
- **One secret, set in Vercel only:** `FIREBASE_SERVICE_ACCOUNT` = the Firebase service account JSON (Project settings → Service accounts → Generate new private key). Never commit it.
- **Stickers:** write the URLs in [tags/tags.csv](tags/tags.csv) with NFC Tools (Add record → URL). Tags seed into Firestore automatically on the first tap.

## Notes

`npm run dev` sets this already. Running the Firestore emulator by hand on Windows needs a short Java socket temp dir:
```bash
JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/Users/Public/qs-jtmp" npx firebase-tools emulators:start --only auth,firestore --project demo-queuesense
```
