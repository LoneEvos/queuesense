// Live queue state. Pure functions: no I/O.
//
// Server-only doc  queue_state/{stop_id}:
//   { entries: { [hashed_user_id]: join_ms }, recent_boards: [{ ms, wait_s }] }
// Public doc       live/{stop_id}  (aggregates only, no IDs):
//   { queue_length, join_ms (sorted, so a phone can find its own place), est_wait_min, ... }

export const QUEUE_EXPIRY_MS = 60 * 60 * 1000; // a join with no board drops off after 60 min
export const RATE_WINDOW_MS = 15 * 60 * 1000; // boarding rate is measured over 15 min
const RECENT_BOARDS_KEEP_MS = 60 * 60 * 1000;

export function emptyStop() {
  return { entries: {}, recent_boards: [] };
}

/** Drop expired joins and old board records. */
export function prune(state, nowMs) {
  const entries = {};
  for (const [id, ms] of Object.entries(state?.entries ?? {})) {
    if (nowMs - ms < QUEUE_EXPIRY_MS) entries[id] = ms;
  }
  const recent_boards = (state?.recent_boards ?? []).filter((b) => nowMs - b.ms < RECENT_BOARDS_KEEP_MS);
  return { entries, recent_boards };
}

/** 1-based place in the queue for someone who joined at joinMs. */
export function positionOf(state, joinMs) {
  return Object.values(state.entries).filter((ms) => ms <= joinMs).length;
}

/**
 * Estimated wait for someone at `position`.
 * Prefer the measured boarding rate (people boarded per minute over the last 15 min).
 * Fall back to the average measured wait. Null when there is no data yet.
 */
export function estimateWaitMin(state, position, nowMs) {
  const recent = state.recent_boards.filter((b) => nowMs - b.ms < RATE_WINDOW_MS);
  if (recent.length >= 3) {
    const perMin = recent.length / (RATE_WINDOW_MS / 60000);
    return Math.max(1, Math.round(position / perMin));
  }
  const avg = averageWaitMin(state);
  return avg === null ? null : Math.max(1, Math.round(avg));
}

export function averageWaitMin(state) {
  const w = state.recent_boards.filter((b) => typeof b.wait_s === 'number');
  if (!w.length) return null;
  return w.reduce((s, b) => s + b.wait_s, 0) / w.length / 60;
}

export function join(state, userId, joinMs) {
  return { ...state, entries: { ...state.entries, [userId]: joinMs } };
}

/** Remove the user from the queue and record the board. Returns { state, wait_s }. */
export function board(state, userId, boardMs) {
  const joinMs = state.entries[userId];
  const entries = { ...state.entries };
  delete entries[userId];
  const wait_s = joinMs === undefined ? null : Math.max(0, Math.round((boardMs - joinMs) / 1000));
  return {
    state: { entries, recent_boards: [...state.recent_boards, { ms: boardMs, wait_s }] },
    wait_s,
  };
}

/** The public, aggregate-only view of a stop. */
export function summarize(stopId, state, nowMs, extra = {}) {
  const join_ms = Object.values(state.entries).sort((a, b) => a - b);
  const avg = averageWaitMin(state);
  return {
    stop_id: stopId,
    queue_length: join_ms.length,
    join_ms,
    est_wait_min: estimateWaitMin(state, join_ms.length, nowMs),
    avg_wait_min: avg === null ? null : Math.round(avg * 10) / 10,
    boards_last_15min: state.recent_boards.filter((b) => nowMs - b.ms < RATE_WINDOW_MS).length,
    updated_at: new Date(nowMs).toISOString(),
    ...extra,
  };
}
