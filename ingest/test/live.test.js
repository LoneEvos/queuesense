import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as live from '../src/live.js';

const T = Date.parse('2026-11-09T07:30:00Z');
const MIN = 60_000;

test('joins count, positions follow join order', () => {
  let q = live.emptyStop();
  q = live.join(q, 'a', T);
  q = live.join(q, 'b', T + MIN);
  q = live.join(q, 'c', T + 2 * MIN);
  assert.equal(live.positionOf(q, T + MIN), 2);
  const s = live.summarize('stopA', q, T + 3 * MIN);
  assert.equal(s.queue_length, 3);
  assert.deepEqual(s.join_ms, [T, T + MIN, T + 2 * MIN]);
  assert.equal('entries' in s, false, 'public doc must not expose IDs');
});

test('board removes from queue and measures wait', () => {
  let q = live.join(live.emptyStop(), 'a', T);
  const b = live.board(q, 'a', T + 9 * MIN);
  assert.equal(b.wait_s, 540);
  assert.equal(Object.keys(b.state.entries).length, 0);
  assert.equal(live.averageWaitMin(b.state), 9);
});

test('joins expire after 60 minutes', () => {
  let q = live.join(live.emptyStop(), 'a', T);
  q = live.join(q, 'b', T + 30 * MIN);
  const p = live.prune(q, T + 61 * MIN);
  assert.deepEqual(Object.keys(p.entries), ['b']);
});

test('wait estimate uses boarding rate when there is enough data', () => {
  let q = live.emptyStop();
  for (let i = 0; i < 30; i++) q = live.board(live.join(q, `u${i}`, T), `u${i}`, T + 5 * MIN + i * 10_000).state;
  // 30 boards within 15 min = 2/min -> position 12 waits ~6 min.
  assert.equal(live.estimateWaitMin(q, 12, T + 10 * MIN), 6);
  assert.equal(live.estimateWaitMin(live.emptyStop(), 5, T), null);
});

test('handles a 500-person queue', () => {
  let q = live.emptyStop();
  for (let i = 0; i < 500; i++) q = live.join(q, String(i).padStart(64, '0'), T + i * 1000);
  const s = live.summarize('stopA', q, T + 600_000);
  assert.equal(s.queue_length, 500);
  assert.ok(JSON.stringify(q).length < 100_000, 'state doc stays far below the 1 MB Firestore limit');
});
