// Load tags/tags.csv into Firestore tags/{tag_id}.
// Emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-tags.js
// Real project: GOOGLE_CLOUD_PROJECT=<id> node scripts/seed-tags.js (uses gcloud ADC)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const csvPath = fileURLToPath(new URL('../../tags/tags.csv', import.meta.url));
const [header, ...rows] = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'demo-queuesense' });
const db = getFirestore();
const batch = db.batch();

for (const line of rows) {
  const r = Object.fromEntries(line.split(',').map((v, i) => [cols[i], v]));
  batch.set(db.collection('tags').doc(r.tag_id), {
    tag_id: r.tag_id,
    tag_type: r.tag_type,
    stop_id: r.stop_id || null,
    bus_id: r.bus_id || null,
    active: r.active === 'true',
  });
  console.log(`tag ${r.tag_id} (${r.tag_type})`);
}
await batch.commit();
console.log(`Seeded ${rows.length} tags.`);
