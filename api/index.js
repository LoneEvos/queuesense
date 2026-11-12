// Vercel serverless function: the ingest service at /api/* (same origin as the web app).
// One env var is required: FIREBASE_SERVICE_ACCOUNT (the Firebase service account JSON).
// GEMINI_API_KEY (and GEMINI_MODEL) are optional: they turn on the Gemini summary at /api/insights.
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
import { getDispatch } from './_lib/dispatch.js';
import { getInsights } from '../insights/gemini.js';

const server = express();
const serviceAccount = (() => {
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  } catch {
    return null;
  }
})();

// Dispatcher dashboard data (aggregates of SIMULATED history). Works even before the tap
// service is configured: it falls back to the committed snapshot.
server.get('/api/dispatch', async (_req, res, next) => {
  try {
    const data = await getDispatch({ credentials: serviceAccount?.private_key ? serviceAccount : null });
    res.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Gemini summary of the same aggregates (optional GEMINI_API_KEY; without it, a fixed template).
server.get('/api/insights', async (_req, res, next) => {
  try {
    const dispatch = await getDispatch({ credentials: serviceAccount?.private_key ? serviceAccount : null });
    const data = await getInsights(dispatch);
    res.set('Cache-Control', `public, s-maxage=${data.source === 'gemini' ? 3600 : 60}, stale-while-revalidate=3600`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

let setupError = null;
try {
  const sa = serviceAccount;
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
  if (!setupError) return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'No such API path.' });
  console.error(JSON.stringify({ severity: 'ERROR', msg: 'setup failed', err: String(setupError) }));
  res.status(503).json({ status: 'error', code: 'NOT_CONFIGURED', message: 'Server is not configured yet.' });
});
server.use((err, req, res, _next) => {
  console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', err: String(err) }));
  res.status(503).json({ status: 'error', code: 'TRY_AGAIN', message: 'Busy right now. Your tap will retry.' });
});

export default server;
