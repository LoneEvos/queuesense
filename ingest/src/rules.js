// Pure functions: no I/O, so they are easy to unit test.
import { createHash } from 'node:crypto';

export const QUEUE_COOLDOWN_MS = 10 * 60 * 1000; // one QUEUE_JOIN per ID per 10 min
export const JOIN_WINDOW_MS = 60 * 60 * 1000; // BUS_BOARD needs a join in the last 60 min
export const RATE_WINDOW_MS = 60 * 1000;
export const RATE_MAX = 6; // max taps per ID per minute
export const MAX_BUFFER_AGE_MS = 24 * 60 * 60 * 1000; // oldest offline tap we accept
export const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const REPEAT_MS = 30 * 1000; // same board/depart tap from the same ID within 30 s is ignored

const EVENT_FOR_TAG = { QUEUE: 'QUEUE_JOIN', BUS: 'BUS_BOARD', DRIVER: 'BUS_DEPART' };
const TAG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hashUserId(salt, uid) {
  return createHash('sha256').update(salt + uid).digest('hex');
}

/**
 * Validate the client body. The client says WHICH sticker and WHEN; the tag registry decides what it means.
 */
export function parseTapBody(body) {
  if (!body || typeof body !== 'object') return { error: 'Body must be JSON' };
  const { event_id, tag_id, timestamp, offline_buffered } = body;
  if (typeof event_id !== 'string' || !UUID_RE.test(event_id)) return { error: 'event_id must be a UUID' };
  if (typeof tag_id !== 'string' || !TAG_ID_RE.test(tag_id)) return { error: 'tag_id is invalid' };
  if (timestamp !== undefined && typeof timestamp !== 'string') return { error: 'timestamp must be ISO 8601' };
  return {
    value: {
      event_id: event_id.toLowerCase(),
      tag_id,
      timestamp,
      offline_buffered: offline_buffered === true,
    },
  };
}

/**
 * Map a registry tag to its event: queue sticker = join, bus sticker = board, driver sticker = depart.
 * Returns null for unknown tag types. Every boarding therefore comes from a bus sticker and has a bus_id.
 */
export function eventTypeForTag(tag) {
  return EVENT_FOR_TAG[tag?.tag_type] ?? null;
}

/**
 * Which stop's queue a departure closes. A driver sticker sits at one end of the route (its stop_id), so a
 * departure at the APU end never touches the LRT end's queue. Old driver tags without a stop fall back to
 * the stop where the bus last picked people up.
 */
export function departStopFor(tag, bus) {
  return tag?.stop_id ?? bus?.last_stop ?? null;
}

/**
 * Pick the event time. Live taps use server time. Offline-buffered taps keep the
 * phone's tap time, as long as it is within the last 24 h and not in the future.
 */
export function resolveTimestamp(clientTs, offlineBuffered, nowMs) {
  if (!offlineBuffered || !clientTs) return new Date(nowMs).toISOString();
  const t = Date.parse(clientTs);
  if (Number.isNaN(t)) return new Date(nowMs).toISOString();
  if (t > nowMs + MAX_CLOCK_SKEW_MS || t < nowMs - MAX_BUFFER_AGE_MS) return new Date(nowMs).toISOString();
  return new Date(Math.min(t, nowMs)).toISOString();
}

/**
 * Apply anti-spoof rules against this user's ingest state.
 * state: { recent_taps_ms: number[], last_join_ms: number|null }
 * Returns { reject?: {status, code, message}, flagged, flag_reason, nextState }.
 */
export function applyAntiSpoof({ eventType, eventMs, nowMs, state, tagId = null }) {
  const recent = (state?.recent_taps_ms ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
  const lastJoin = state?.last_join_ms ?? null;
  const key = `${eventType}:${tagId}`;

  // A phone re-reading the same sticker must not count twice. Joins are already idempotent
  // (repeat join keeps your place), so this only guards boardings and departures.
  const last = state?.last_tap ?? null;
  if (eventType !== 'QUEUE_JOIN' && last?.key === key && Math.abs(eventMs - last.ms) < REPEAT_MS) {
    return { repeat: true };
  }

  if (recent.length >= RATE_MAX) {
    return { reject: { status: 429, code: 'RATE_LIMITED', message: 'Too many taps. Wait a minute and try again.' } };
  }

  let flagged = false;
  let flag_reason = null;
  let nextJoin = lastJoin;

  if (eventType === 'QUEUE_JOIN') {
    if (lastJoin !== null && Math.abs(eventMs - lastJoin) < QUEUE_COOLDOWN_MS) {
      return { reject: { status: 409, code: 'ALREADY_IN_QUEUE', message: "You're already in the queue." } };
    }
    nextJoin = eventMs;
  } else if (eventType === 'BUS_BOARD') {
    if (lastJoin === null || eventMs - lastJoin > JOIN_WINDOW_MS || eventMs < lastJoin) {
      flagged = true;
      flag_reason = 'BOARD_WITHOUT_JOIN';
    }
    // A board consumes the join, so the next trip needs a fresh queue tap.
    nextJoin = flagged ? lastJoin : null;
  }

  return {
    flagged,
    flag_reason,
    nextState: { recent_taps_ms: [...recent, nowMs], last_join_ms: nextJoin, last_tap: { key, ms: eventMs } },
  };
}
