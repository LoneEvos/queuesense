// Vercel serverless function: the ingest service at /api/* (same origin as the web app).
// One env var is required: FIREBASE_SERVICE_ACCOUNT (the Firebase service account JSON).
// HASH_SALT is optional; by default it is derived from the service account's private key,
// so it stays server-side and stable without a second secret.
import { createHash } from 'node:crypto';
import express from 'express';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from '../ingest/src/app.js';
import { makeConfig } from '../ingest/src/config.js';
import { ensureTags } from '../ingest/src/tags.js';

const server = express();

let setupError = null;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (!sa?.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const config = makeConfig(process.env, {
    projectId: sa.project_id,
    hashSalt: createHash('sha256').update(`queuesense-salt:${sa.private_key}`).digest('hex'),
  });
  if (!getApps().length) initializeApp({ credential: cert(sa), projectId: config.projectId });
  const auth = getAuth();
  const db = getFirestore();

  // Seed the tag registry before the first tap is handled.
  server.use('/api', (req, res, next) =>
    ensureTags(db).then(
      () => next(),
      (err) => next(err),
    ),
  );
  server.use('/api', createApp({ verifyIdToken: (t) => auth.verifyIdToken(t), db, config }));
} catch (err) {
  setupError = err;
}

server.use('/api', (req, res) => {
  console.error(JSON.stringify({ severity: 'ERROR', msg: 'setup failed', err: String(setupError) }));
  res.status(503).json({ status: 'error', code: 'NOT_CONFIGURED', message: 'Server is not configured yet.' });
});
server.use((err, req, res, _next) => {
  console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', err: String(err) }));
  res.status(503).json({ status: 'error', code: 'TRY_AGAIN', message: 'Busy right now. Your tap will retry.' });
});

export default server;
