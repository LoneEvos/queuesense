#!/usr/bin/env node
// Live tap simulator: sends the same request the tap page sends, as anonymous students.
// No dependencies. Works against the emulators or a real deployment.
//
//   node simulator/send-tap.js stopA-q1                      one student joins the queue
//   node simulator/send-tap.js stopA-q1 bus01-door1 --students 5   five students join then board
//   node simulator/send-tap.js bus01-driver                  bus departs
//
// Env (defaults target the local emulators):
//   INGEST_URL=http://localhost:8081/api
//   FIREBASE_API_KEY=demo-key
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099   (unset for real Firebase)
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const n = Number(args.includes('--students') ? args[args.indexOf('--students') + 1] : 1);
const tags = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--students');
if (!tags.length) {
  console.error('usage: node simulator/send-tap.js <tag_id> [<tag_id> ...] [--students N]');
  process.exit(1);
}

const INGEST_URL = process.env.INGEST_URL || 'http://localhost:8081/api';
const API_KEY = process.env.FIREBASE_API_KEY || 'demo-key';
const AUTH_EMU = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const authBase = AUTH_EMU
  ? `http://${AUTH_EMU}/identitytoolkit.googleapis.com`
  : 'https://identitytoolkit.googleapis.com';

async function anonymousToken() {
  const res = await fetch(`${authBase}/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`anonymous sign-in failed: ${JSON.stringify(data)}`);
  return data.idToken;
}

async function tap(token, tag_id) {
  const res = await fetch(`${INGEST_URL}/tap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event_id: randomUUID(), tag_id, timestamp: new Date().toISOString(), offline_buffered: false }),
  });
  return { status: res.status, body: await res.json() };
}

let failed = 0;
for (let s = 1; s <= n; s++) {
  const token = await anonymousToken();
  for (const tag of tags) {
    const r = await tap(token, tag);
    if (r.status >= 300) failed++;
    const b = r.body;
    console.log(
      `student ${s} ${tag.padEnd(14)} ${r.status} ${b.event_type ?? b.code}` +
        (b.flagged ? ` flagged=${b.flag_reason}` : '') +
        (b.simulated ? ' [simulated]' : ''),
    );
  }
}
process.exitCode = failed ? 1 : 0;
