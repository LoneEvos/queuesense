// Local server (npm run dev). On Vercel the same app runs from /api/index.js.
import express from 'express';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { makeConfig } from './config.js';
import { createApp } from './app.js';
import { ensureTags } from './tags.js';
import { getDispatch } from '../../api/_lib/dispatch.js';

// Emulators are picked up automatically from FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST.
const config = makeConfig();
initializeApp({ projectId: config.projectId });
const auth = getAuth();
const db = getFirestore();
console.log(JSON.stringify({ severity: 'INFO', msg: 'tags seeded', added: await ensureTags(db) }));

const server = express();
// Local: no BigQuery credentials, so the dashboard reads sql/dispatch-snapshot.json.
server.get('/api/dispatch', async (_req, res) => res.json(await getDispatch()));
server.use('/api', createApp({ verifyIdToken: (t) => auth.verifyIdToken(t), db, config }));
server.listen(config.port, () => {
  console.log(
    JSON.stringify({ severity: 'INFO', msg: 'ingest listening', port: config.port, simulation_mode: config.simulationMode }),
  );
});
