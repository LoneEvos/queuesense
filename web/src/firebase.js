import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signOut,
} from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot } from 'firebase/firestore';

const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
if (env.VITE_USE_EMULATORS === 'true') {
  // Use the page's host so phones on the same Wi-Fi reach the PC's emulators too.
  const host = window.location.hostname;
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
}

/**
 * Subscribe to a stop's public live doc. Returns an unsubscribe function.
 * onError(err) is called if sign-in or the listener fails; sign-in is retried every 5 s.
 */
export function watchStop(stopId, onData, onError = () => {}) {
  let off = () => {};
  let cancelled = false;
  let timer = null;
  let unreachable = null;
  const start = () =>
    ready
      .then(() => (auth.currentUser ? null : signInAnonymously(auth)))
      .then(() => {
        if (cancelled) return;
        off = onSnapshot(
          doc(db, 'live', stopId),
          { includeMetadataChanges: true },
          (snap) => {
            // An empty answer from the local cache only means "not heard from the server yet",
            // not "no taps". If the server stays silent for 6 s, report it as unreachable.
            if (snap.metadata.fromCache && !snap.exists()) {
              unreachable ??= setTimeout(() => onError({ code: 'unavailable' }), 6000);
              return;
            }
            clearTimeout(unreachable);
            unreachable = null;
            onData(snap.exists() ? snap.data() : null);
          },
          (err) => {
            console.warn('[live]', err.code);
            onError(err);
          },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[live] sign-in failed', err.code ?? err);
        onError(err);
        timer = setTimeout(start, 5000);
      });
  start();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    clearTimeout(unreachable);
    off();
  };
}

/** One read of a stop's live doc. Resolves to the data, null (no doc yet) or undefined (timed out / failed). */
export function readStop(stopId, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let stop = () => {};
    const done = (v) => {
      clearTimeout(t);
      stop();
      resolve(v);
    };
    const t = setTimeout(() => done(undefined), timeoutMs);
    stop = watchStop(stopId, (d) => done(d), () => {});
  });
}

/** This device's anonymous user ID (signs in on first visit). null if sign-in is not possible right now. */
export async function currentUid() {
  try {
    await ready;
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser.uid;
  } catch {
    return null;
  }
}

// Wait for Firebase to restore the saved user (if any) before deciding to sign in.
const ready = new Promise((resolve) => {
  const off = onAuthStateChanged(auth, () => {
    off();
    resolve();
  });
});

/** Anonymous sign-in on first visit. Returns a fresh Firebase ID token. */
export async function getIdToken() {
  await ready;
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser.getIdToken();
}

/** Simulation helper: drop this phone's anonymous ID so the next tap is a "new student". */
export async function becomeNewStudent() {
  await ready;
  await signOut(auth);
  await signInAnonymously(auth);
}
