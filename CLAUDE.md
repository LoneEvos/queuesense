# QueueSense

APU shuttle bus queue intelligence. NTAG213 NFC stickers sit at the queue point, inside the bus door and at the driver seat. Students tap their own phone on a sticker; it opens our web app at /t/{tag_id}, which records QUEUE_JOIN, BUS_BOARD or BUS_DEPART. We match taps by an anonymous hashed ID to measure wait times, live queue length and left-behind counts, forecast demand, and recommend bus deployment. Built for the APU Cloud Innovation Hackathon 2026, Track 3 (Data-Driven Decision Making). Prototype submission: 13 Nov 2026, 12:00 noon MYT (does not need Gemini Enterprise). Top 5 final pitch: 17 Nov 2026, must use Gemini Enterprise tools.

Full context: the Project Context page in the team Notion. It is the source of truth. If a request conflicts with it, point out the conflict and ask whether to update it.

## There is no reader hardware

No ESP32, no PN532, no GPS. Stickers only store a URL. The student's phone is the reader. Do not add firmware or hardware.

## Stack (simple, free tier, build this first)

Sticker -> React PWA tap page (Vercel) -> ingest (one HTTPS function, single instance) -> Firestore (live count + event history) -> student view `/live`, dispatcher view -> BigQuery sandbox (history export + BigQuery ML forecast) -> Gemini (insights, server-side).

No Pub/Sub and no separate processor: scale is 200-500 people per queue, so ingest updates the live count directly in one Firestore transaction per tap. Ingest runs its transactions one at a time (they all touch the same stop doc); tested at 500 students / 1,000+ taps with 0 failures. Everything must stay on free tiers with no billing account. Develop locally on the Firebase emulators (`npm run dev`); NFC is simulated until the real stickers arrive.

Do NOT use or suggest Google Cloud IoT Core. It was shut down in August 2023.

## Repo layout

```
/web           React PWA (Vercel): / NFC simulator, /t/:tagId tap page, /live/:stopId live count, /dispatch dispatcher view
/ingest        HTTPS function: verifies Firebase ID token, looks up tag, anti-spoof rules, hashes ID, updates live queue + logs event in one Firestore transaction
/processor     (not needed at this scale; matching and live state live in /ingest)
/sql           BigQuery schemas, export of Firestore events, BigQuery ML models
/simulator     send-tap.js, rush.js (200-500 student rush hour), watch-live.js; synthetic history generator (demo fallback)
/insights      Gemini summary job (Cloud Scheduler)
/tags          sticker list: tag_id, type, stop_id, bus_id, URL to write
```

## Identity

Firebase Anonymous Auth on first visit. The app sends the Firebase ID token to ingest; ingest verifies it and stores only sha256(salt + uid). The salt is a server-side secret (env var on the host, never in the repo or browser). Never collect TP number, name, email, phone number or location.

## Firestore layout

- `tags/{tag_id}`: tag_id, tag_type (QUEUE | BUS | DRIVER), stop_id, bus_id, active. stop_id and bus_id always come from here, never from the client.
- `live/{stop_id}`: public aggregates only (queue_length, join_ms, est_wait_min, avg_wait_min, boards_last_15min, last_departure, simulated). The only collection clients may read.
- `queue_state/{stop_id}`, `bus_state/{bus_id}`, `ingest_state/{hashed_id}`: server-only working state.
- `events/{event_id}`: one row per tap (event schema + flagged, flag_reason, wait_seconds, queue_position_at_join). History source for BigQuery.
- `trips/{event_id}`: one row per departure (boarded_count, left_behind_count).

## Event schema (every service must match this)

```json
{
  "event_id": "uuid",
  "event_type": "QUEUE_JOIN | BUS_BOARD | BUS_DEPART",
  "hashed_user_id": "sha256(salt + firebase_uid)",
  "tag_id": "stopA-q1",
  "stop_id": "stopA",
  "bus_id": null,
  "timestamp": "ISO 8601 UTC",
  "offline_buffered": false,
  "simulated": false
}
```

## BigQuery tables (sandbox, free)

raw_events, matched_journeys, bus_trips, queue_snapshots, forecasts, loaded from Firestore `events` and `trips`. Every table has a `simulated` column. See Project Context section 7.

## Matching rules

1. For each BUS_BOARD, match the latest unmatched QUEUE_JOIN with the same hashed_user_id in the last 60 minutes.
2. wait_seconds = board_ts - queue_join_ts.
3. Live queue = unmatched QUEUE_JOIN, expired after 60 minutes.
4. BUS_DEPART closes the trip: boarded_count since the last departure; left_behind = live queue at that stop.
5. BUS_BOARD is the source of truth. Scale observed queue by the historical queue-tap rate.

## Anti-spoof rules (ingest)

- Reject unknown or inactive tag_id
- Max one QUEUE_JOIN per ID per 10 minutes
- BUS_BOARD without a QUEUE_JOIN in the last 60 minutes is accepted but flagged
- Rate limit per ID
- BUS_DEPART only from DRIVER tags or the dispatcher view

## Rules for writing code

- The tap page must load fast and work offline: queue the event in IndexedDB and send on reconnect with offline_buffered = true.
- Show a clear confirmation after a tap ("You're #12 in the queue, about 9 min").
- Clients never write to Firestore or BigQuery directly. Firestore rules: read-only for clients.
- No cameras, no face recognition, no location tracking.
- Dashboards and the student view show aggregates only.
- Gemini is called only from server-side code. Secrets stay server-side, never in the repo or browser.
- Line-cut handling is flag and warn only, never block.
- Label all simulated data as simulated in tables and on every dashboard.
- Times stored in UTC, displayed in Asia/Kuala_Lumpur.
- Favour the simplest option that works end to end. Ask before adding stretch features.

## Demo must work without phones

The simulator can send the same events to ingest. Keep it working at all times.
