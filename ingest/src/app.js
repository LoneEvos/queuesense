import express from 'express';
import {
  applyAntiSpoof,
  eventTypeForTag,
  hashUserId,
  parseTapBody,
  resolveTimestamp,
} from './rules.js';
import * as live from './live.js';

/**
 * One request does everything, in one Firestore transaction:
 * verify -> tag lookup -> anti-spoof -> update the live queue -> log the event.
 *
 * Firestore layout (clients may read only live/*):
 *   tags/{tag_id}            registry
 *   live/{stop_id}           public aggregates: queue_length, est_wait_min, last_departure ...
 *   queue_state/{stop_id}    server-only: who is queueing (hashed IDs) + recent boards
 *   bus_state/{bus_id}       server-only: boards since last departure, last stop
 *   ingest_state/{hashed}    server-only: cooldowns, last join
 *   events/{event_id}        history, one row per tap (shared event schema + flags + wait_s)
 *   trips/{event_id}         one row per departure
 *
 * deps: { verifyIdToken(token) -> { uid }, db: Firestore, config, now() -> ms }
 */
export function createApp({ verifyIdToken, db, config, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  // CORS: only our web app origins.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Max-Age', '3600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, simulation_mode: config.simulationMode }));

  app.post('/tap', async (req, res) => {
    // 1. Identity: Firebase ID token (anonymous auth).
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return fail(res, 401, 'NO_TOKEN', 'Missing sign-in token.');
    let uid;
    try {
      ({ uid } = await verifyIdToken(m[1]));
    } catch {
      return fail(res, 401, 'BAD_TOKEN', 'Sign-in token is invalid or expired.');
    }

    // 2. Body: which sticker, when.
    const parsed = parseTapBody(req.body);
    if (parsed.error) return fail(res, 400, 'BAD_REQUEST', parsed.error);
    const { event_id, tag_id, timestamp, offline_buffered, action } = parsed.value;

    // 3. Tag registry decides what the tap means.
    const tagSnap = await db.collection('tags').doc(tag_id).get();
    if (!tagSnap.exists) return fail(res, 404, 'UNKNOWN_TAG', 'This sticker is not registered.');
    const tag = tagSnap.data();
    if (tag.active !== true) return fail(res, 403, 'INACTIVE_TAG', 'This sticker is not active.');
    const event_type = eventTypeForTag(tag, action);
    if (!event_type) return fail(res, 500, 'BAD_TAG', 'Sticker has an unknown type.');

    const hashed_user_id = hashUserId(config.hashSalt, uid);
    const nowMs = now();
    const eventTs = resolveTimestamp(timestamp, offline_buffered, nowMs);
    const eventMs = Date.parse(eventTs);

    const event = {
      event_id,
      event_type,
      hashed_user_id,
      tag_id,
      stop_id: tag.stop_id ?? null,
      bus_id: tag.bus_id ?? null,
      timestamp: eventTs,
      offline_buffered,
      simulated: config.simulationMode,
    };

    const col = (name) => db.collection(name);
    const eventRef = col('events').doc(event_id);
    const userRef = col('ingest_state').doc(hashed_user_id);

    let out;
    try {
      out = await serial(() => db.runTransaction(async (tx) => {
        // ---- reads (all before any write) ----
        const [seen, userSnap] = await Promise.all([tx.get(eventRef), tx.get(userRef)]);
        if (seen.exists) return { duplicate: true, reply: seen.data().reply };
        const user = userSnap.exists ? userSnap.data() : null;

        const r = applyAntiSpoof({ eventType: event_type, eventMs, nowMs, state: user, tagId: tag_id });
        if (r.reject) return r;
        if (r.repeat) {
          // Same sticker, same meaning, within 30 s: answer OK but count nothing.
          return { already: true, reply: { ...baseReply(event, { flagged: false }), status: 'repeat_ignored' } };
        }

        const busRef = event.bus_id ? col('bus_state').doc(event.bus_id) : null;
        const busSnap = busRef ? await tx.get(busRef) : null;
        const bus = busSnap?.exists ? busSnap.data() : { boarded_since_depart: 0, last_stop: null };

        // Which stop's queue this tap touches.
        let stopId = null;
        if (event_type === 'QUEUE_JOIN') stopId = event.stop_id;
        if (event_type === 'BUS_BOARD' && !r.flagged) stopId = user?.last_join_stop ?? null;
        if (event_type === 'BUS_DEPART') stopId = bus.last_stop;

        const qRef = stopId ? col('queue_state').doc(stopId) : null;
        const qSnap = qRef ? await tx.get(qRef) : null;
        let q = live.prune(qSnap?.exists ? qSnap.data() : live.emptyStop(), nowMs);

        // ---- apply ----
        const reply = baseReply(event, r);
        let liveExtra = {};
        let row = { ...event, flagged: r.flagged, flag_reason: r.flag_reason };

        if (event_type === 'QUEUE_JOIN' && q.entries[hashed_user_id] !== undefined) {
          // Still queueing from an earlier tap: keep their place, change nothing.
          const joinedMs = q.entries[hashed_user_id];
          const position = live.positionOf(q, joinedMs);
          return {
            already: true,
            reply: {
              ...baseReply(event, r),
              status: 'already_in_queue',
              timestamp: new Date(joinedMs).toISOString(),
              position,
              queue_length: Object.keys(q.entries).length,
              est_wait_min: live.estimateWaitMin(q, position, nowMs),
            },
          };
        }

        if (event_type === 'QUEUE_JOIN') {
          q = live.join(q, hashed_user_id, eventMs);
          reply.position = live.positionOf(q, eventMs);
          reply.queue_length = Object.keys(q.entries).length;
          reply.est_wait_min = live.estimateWaitMin(q, reply.position, nowMs);
          row.queue_position_at_join = reply.position;
        }

        if (event_type === 'BUS_BOARD') {
          if (qRef) {
            const b = live.board(q, hashed_user_id, eventMs);
            q = b.state;
            reply.wait_s = b.wait_s;
            row.wait_seconds = b.wait_s;
            row.boarding_stop_id = stopId;
          }
          // Boarding at the stop sticker (one-sticker demo) has no bus to credit.
          if (busRef) {
            tx.set(busRef, {
              boarded_since_depart: (bus.boarded_since_depart ?? 0) + 1,
              last_stop: stopId ?? bus.last_stop ?? null,
            });
          }
        }

        if (event_type === 'BUS_DEPART') {
          const trip = {
            bus_id: event.bus_id,
            stop_id: stopId,
            departure_ts: eventTs,
            boarded_count: bus.boarded_since_depart ?? 0,
            left_behind_count: qRef ? Object.keys(q.entries).length : null,
            simulated: event.simulated,
          };
          tx.set(col('trips').doc(event_id), trip);
          tx.set(busRef, { boarded_since_depart: 0, last_stop: bus.last_stop ?? null });
          reply.boarded_count = trip.boarded_count;
          reply.left_behind_count = trip.left_behind_count;
          liveExtra = { last_departure: { bus_id: trip.bus_id, at: eventTs, ...pick(trip) } };
        }

        // ---- writes ----
        tx.set(userRef, {
          ...r.nextState,
          last_join_stop: event_type === 'QUEUE_JOIN' ? event.stop_id : r.nextState.last_join_ms ? user?.last_join_stop ?? null : null,
        });
        if (qRef) {
          tx.set(qRef, q);
          tx.set(
            col('live').doc(stopId),
            live.summarize(stopId, q, nowMs, { simulated: event.simulated, ...liveExtra }),
            { merge: true },
          );
        }
        tx.set(eventRef, { ...row, received_at: new Date(nowMs).toISOString(), reply });
        return { reply };
      }));
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', msg: 'transaction failed', err: String(err) }));
      // Client keeps the tap in IndexedDB and retries with the same event_id.
      return fail(res, 503, 'TRY_AGAIN', 'Busy right now. Your tap will retry.');
    }

    if (out.reject) {
      const { status, code, message } = out.reject;
      return fail(res, status, code, message);
    }
    console.log(JSON.stringify({ severity: 'INFO', msg: 'tap', event_id, event_type, tag_id, ...out.reply }));
    return res.status(out.duplicate || out.already ? 200 : 202).json({ ...out.reply, duplicate: !!out.duplicate });
  });

  return app;
}

// Every tap touches the same few docs (the stop's queue, the bus). Running the transactions
// one at a time avoids lock fights; each takes ~20-50 ms, so one instance handles 20+ taps/s,
// well above a 500-person queue. Deploy ingest as a single instance.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function baseReply(event, r) {
  return {
    status: 'accepted',
    event_id: event.event_id,
    event_type: event.event_type,
    stop_id: event.stop_id,
    bus_id: event.bus_id,
    timestamp: event.timestamp,
    simulated: event.simulated,
    flagged: r.flagged,
    flag_reason: r.flag_reason ?? null,
  };
}

const pick = ({ boarded_count, left_behind_count }) => ({ boarded_count, left_behind_count });

function fail(res, status, code, message) {
  return res.status(status).json({ status: 'error', code, message });
}
