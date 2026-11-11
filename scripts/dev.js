#!/usr/bin/env node
// One command, all local, all free:
//   Firebase emulators (Auth, Firestore) -> seed tags -> ingest -> web -> live count watcher.
// Ctrl+C stops everything.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
const children = [];

// Local env files from the examples, first run only.
for (const dir of ['ingest', 'web']) {
  const local = join(root, dir, '.env.local');
  if (!existsSync(local)) copyFileSync(join(root, dir, '.env.example'), local);
}

// Java (Firestore emulator) fails on Windows when its socket temp path is long
// or unusual. Point it at a short folder.
const env = { ...process.env };
if (isWin) {
  const jtmp = 'C:\\Users\\Public\\qs-jtmp';
  mkdirSync(jtmp, { recursive: true });
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ?? ''} -Djdk.net.unixdomain.tmpdir=${jtmp.replaceAll('\\', '/')}`.trim();
}
const emuEnv = {
  ...env,
  GOOGLE_CLOUD_PROJECT: 'demo-queuesense',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

const COLORS = { emu: 90, seed: 35, ingest: 36, web: 32, live: 33 };
function run(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: root, env: emuEnv, shell: isWin, ...opts });
  const tag = `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) out.write(tag + l + '\n');
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  children.push(p);
  return p;
}

const exited = (p) => new Promise((r) => p.on('exit', r));

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${label} did not start`);
}

function stopAll() {
  for (const p of children) {
    if (p.exitCode !== null) continue;
    if (isWin) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGINT');
  }
}
process.on('SIGINT', () => {
  stopAll();
  setTimeout(() => process.exit(0), 1500);
});

// Fail fast if an old run is still holding a port.
const PORTS = { 9099: 'Auth emulator', 8080: 'Firestore emulator', 8081: 'ingest', 5173: 'web' };
const busy = [];
for (const [port, name] of Object.entries(PORTS)) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    busy.push(`${port} (${name})`);
  } catch (err) {
    if (err.name === 'TimeoutError') busy.push(`${port} (${name})`);
  }
}
if (busy.length) {
  console.error(`Ports already in use: ${busy.join(', ')}. Stop the old run first.`);
  process.exit(1);
}

// firebase-tools is not a project dependency (it would bloat the Vercel deploy). Use a local copy if there
// is one, otherwise npx fetches it once into its cache.
const firebaseBin = join(root, 'node_modules', '.bin', isWin ? 'firebase.cmd' : 'firebase');
const [emuCmd, ...emuPre] = existsSync(firebaseBin) ? [`"${firebaseBin}"`] : ['npx', '--yes', 'firebase-tools@14'];
run('emu', emuCmd, [...emuPre, 'emulators:start', '--only', 'auth,firestore', '--project', 'demo-queuesense'], {
  env,
});

try {
  await waitFor('http://127.0.0.1:9099/', 'Auth emulator');
  await waitFor('http://127.0.0.1:8080/', 'Firestore emulator');

  run('ingest', 'node', ['--env-file=.env.local', '--watch', 'src/index.js'], { cwd: join(root, 'ingest') });
  await waitFor('http://localhost:8081/api/healthz', 'ingest');
  run('live', 'node', ['simulator/watch-live.js', 'stopA']);
  run('web', 'npm', ['run', 'dev', '--', '--host'], { cwd: join(root, 'web') });

  console.log('\n  QueueSense local stack is up (simulation)');
  console.log('  Live count:     http://localhost:5173/');
  console.log('  NFC simulator:  http://localhost:5173/sim');
  console.log('  Ingest:         http://localhost:8081/api/healthz');
  console.log('  Rush hour:      npm run rush   (in another terminal)');
  console.log('  Count changes print below as [live]. Ctrl+C to stop.\n');
} catch (err) {
  console.error(String(err));
  stopAll();
  process.exit(1);
}
