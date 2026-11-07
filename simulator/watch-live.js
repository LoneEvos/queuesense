#!/usr/bin/env node
// Print the live count for a stop whenever it changes (Firestore emulator).
//   node simulator/watch-live.js [stopA]
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'demo-queuesense';
const stop = process.argv[2] || 'stopA';
const url = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/live/${stop}`;

const val = (f) => (f == null ? null : (f.integerValue ?? f.doubleValue ?? f.stringValue ?? null));
let lastLine = '';
console.log(`watching live/${stop}`);
while (true) {
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
    if (r.ok) {
      const f = (await r.json()).fields;
      const dep = f.last_departure?.mapValue?.fields;
      const line =
        `queue=${val(f.queue_length)} wait~${val(f.est_wait_min) ?? '?'}min boarded15m=${val(f.boards_last_15min)}` +
        (dep ? ` lastBus: ${val(dep.boarded_count)} on, ${val(dep.left_behind_count)} left` : '');
      if (line !== lastLine) console.log(line);
      lastLine = line;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
