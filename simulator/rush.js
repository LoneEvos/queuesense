#!/usr/bin/env node
// Rush-hour simulator: N students join the queue, then buses come and take them in batches.
// Calls ingest exactly like phones do. Demo fallback when there are no phones.
//
//   node simulator/rush.js                       300 students, buses of 40
//   node simulator/rush.js --students 500 --bus 40 --concurrency 25 --gap 2000
//
// Env: INGEST_URL (default http://localhost:8081), FIREBASE_API_KEY, FIREBASE_AUTH_EMULATOR_HOST
import { randomUUID } from 'node:crypto';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
const STUDENTS = arg('students', 300);
const BUS_SIZE = arg('bus', 40);
const CONCURRENCY = arg('concurrency', 20);
const GAP_MS = arg('gap', 1500); // pause between buses
const BUSES = arg('buses', Math.ceil(STUDENTS / BUS_SIZE));

const INGEST_URL = process.env.INGEST_URL || 'http://localhost:8081/api';
const API_KEY = process.env.FIREBASE_API_KEY || 'demo-key';
const AUTH_EMU = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const authBase = AUTH_EMU ? `http://${AUTH_EMU}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';

async function token() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await signUp();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
  }
}

async function signUp() {
  const r = await fetch(`${authBase}/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.idToken;
}

async function tap(tok, tag_id) {
  // Same event_id on retry, like the phone's outbox, so a retry never double-counts.
  const event_id = randomUUID();
  const timestamp = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await fetch(`${INGEST_URL}/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ event_id, tag_id, timestamp }),
      });
    } catch {
      await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
      continue;
    }
    const body = await r.json();
    if (r.status !== 503) return { status: r.status, body, ms: 0 };
    await new Promise((res) => setTimeout(res, 200 * (attempt + 1))); // same as the phone's retry
  }
  return { status: 503, body: {} };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const stats = { ok: 0, fail: 0, latencies: [] };
async function timed(tok, tag) {
  const t0 = performance.now();
  const r = await tap(tok, tag);
  stats.latencies.push(performance.now() - t0);
  r.status < 300 ? stats.ok++ : stats.fail++;
  return r;
}

console.log(`Rush: ${STUDENTS} students, ${BUSES} buses of ${BUS_SIZE}, ${CONCURRENCY} at a time [simulated]`);
const tokens = await pool(Array.from({ length: STUDENTS }), 5, () => token());

const t0 = Date.now();
const joins = await pool(tokens, CONCURRENCY, (tok) => timed(tok, 'stopA-q1'));
const last = joins.filter((j) => j.status < 300).at(-1)?.body;
console.log(`joined: ${stats.ok}/${STUDENTS} in ${((Date.now() - t0) / 1000).toFixed(1)}s, queue_length=${last?.queue_length}`);

let next = 0;

for (let b = 1; b <= BUSES && next < STUDENTS; b++) {
  await new Promise((r) => setTimeout(r, GAP_MS));
  const batch = tokens.slice(next, next + BUS_SIZE);
  next += batch.length;
  await pool(batch, CONCURRENCY, (tok) => timed(tok, b % 2 ? 'bus01-door1' : 'bus01-door2'));
  const d = await timed(await token(), 'bus01-driver'); // a fresh phone per bus, like a real shift
  console.log(`bus ${b}: boarded=${d.body.boarded_count} left_behind=${d.body.left_behind_count}`);
}

const lat = stats.latencies.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.floor(q * (lat.length - 1))]);
console.log(`taps ok=${stats.ok} failed=${stats.fail} latency p50=${p(0.5)}ms p95=${p(0.95)}ms max=${p(1)}ms`);
process.exitCode = stats.fail ? 1 : 0;
