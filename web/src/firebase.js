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

/** Subscribe to a stop's public live doc. Returns an unsubscribe function. */
export function watchStop(stopId, onData) {
  let off = () => {};
  let cancelled = false;
  ready
    .then(() => (auth.currentUser ? null : signInAnonymously(auth)))
    .then(() => {
      if (cancelled) return;
      off = onSnapshot(
        doc(db, 'live', stopId),
        (snap) => onData(snap.exists() ? snap.data() : null),
        (err) => console.warn('[live]', err.code),
      );
    });
  return () => {
    cancelled = true;
    off();
  };
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
