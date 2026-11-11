// Store-and-forward: every tap is written to IndexedDB first, then sent.
// If sending fails it stays here and is retried on reconnect with offline_buffered = true.
import { getIdToken } from './firebase.js';

const DB = 'queuesense';
const STORE = 'outbox';
// Same origin: /api is the Vercel function in production and the Vite proxy locally.
const INGEST_URL = import.meta.env.VITE_INGEST_URL || '/api';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'event_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const putTap = (tap) => tx('readwrite', (s) => s.put(tap));
export const deleteTap = (id) => tx('readwrite', (s) => s.delete(id));
export const listTaps = () => tx('readonly', (s) => s.getAll());

/** Create and persist a tap. The tap time is captured now, on the phone. */
export async function recordTap(tagId, { action = null } = {}) {
  const tap = {
    event_id: crypto.randomUUID(),
    tag_id: tagId,
    timestamp: new Date().toISOString(),
    attempts: 0,
    ...(action ? { action } : {}),
  };
  await putTap(tap);
  return tap;
}

/**
 * Try to send one tap.
 * Returns { kind: 'accepted' | 'rejected' | 'queued', data }.
 *  accepted: ingest took it (or already had it)
 *  rejected: ingest said no for good (unknown sticker, cooldown, ...), removed from the outbox
 *  queued:   network or server trouble, kept for retry
 */
const inFlight = new Set();

export async function sendTap(tap) {
  if (inFlight.has(tap.event_id)) return { kind: 'queued', data: { message: 'Already sending' } };
  inFlight.add(tap.event_id);
  try {
    return await sendTapOnce(tap);
  } finally {
    inFlight.delete(tap.event_id);
  }
}

async function sendTapOnce(tap) {
  const offline_buffered = tap.attempts > 0;
  try {
    const token = await getIdToken();
    const res = await fetch(`${INGEST_URL}/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        event_id: tap.event_id,
        tag_id: tap.tag_id,
        timestamp: tap.timestamp,
        offline_buffered,
        ...(tap.action ? { action: tap.action } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await deleteTap(tap.event_id);
      return { kind: 'accepted', data };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
      await deleteTap(tap.event_id);
      return { kind: 'rejected', data };
    }
    // Server reached but not able to take it right now: keep it and retry.
    await putTap({ ...tap, attempts: tap.attempts + 1 });
    return { kind: 'queued', data: { reason: 'server', code: data.code, message: data.message || `HTTP ${res.status}` } };
  } catch (err) {
    // Network failure: no signal, or the server could not be reached at all.
    await putTap({ ...tap, attempts: tap.attempts + 1 });
    return { kind: 'queued', data: { reason: 'network', message: String(err.message || err) } };
  }
}

/** Send everything still waiting. Oldest first. */
export async function flushOutbox() {
  const taps = (await listTaps()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const results = [];
  for (const tap of taps) results.push({ tap, ...(await sendTap(tap)) });
  return results;
}

let flushing = false;
export function startBackgroundFlush(onResult) {
  const run = async () => {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      for (const r of await flushOutbox()) onResult?.(r);
    } finally {
      flushing = false;
    }
  };
  window.addEventListener('online', run);
  const timer = setInterval(run, 30_000);
  run();
  return () => {
    window.removeEventListener('online', run);
    clearInterval(timer);
  };
}
