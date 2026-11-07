import { useEffect, useState } from 'react';
import { watchStop } from './firebase.js';

const EXPIRY_MS = 60 * 60 * 1000;

/** Live, aggregate view of a stop. Re-checks expiry every 30 s so the count stays right with no taps. */
export function useStop(stopId) {
  const [data, setData] = useState(undefined);
  const [now, setNow] = useState(Date.now());
  useEffect(() => (stopId ? watchStop(stopId, setData) : undefined), [stopId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!data) return { loading: data === undefined, data: null };
  const joins = (data.join_ms ?? []).filter((ms) => now - ms < EXPIRY_MS);
  return { loading: false, data: { ...data, queue_length: joins.length, join_ms: joins } };
}

/** My place, from my own join time. Moves up live as people ahead board. */
export function positionFor(stop, myJoinMs) {
  if (!stop || !myJoinMs) return null;
  if (!stop.join_ms.includes(myJoinMs)) return null; // boarded or expired
  return stop.join_ms.filter((ms) => ms <= myJoinMs).length;
}

export function waitFor(stop, position) {
  if (!stop || !position) return null;
  if (stop.boards_last_15min >= 3) return Math.max(1, Math.round(position / (stop.boards_last_15min / 15)));
  return stop.avg_wait_min ? Math.max(1, Math.round(stop.avg_wait_min)) : null;
}
