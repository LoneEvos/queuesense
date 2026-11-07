import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAntiSpoof,
  eventTypeForTag,
  hashUserId,
  parseTapBody,
  resolveTimestamp,
  QUEUE_COOLDOWN_MS,
  RATE_MAX,
} from '../src/rules.js';

const NOW = Date.parse('2026-11-09T07:32:11Z');
const MIN = 60 * 1000;

test('hash is sha256(salt + uid), hex', () => {
  assert.equal(hashUserId('salt', 'uid'), hashUserId('salt', 'uid'));
  assert.notEqual(hashUserId('salt', 'uid'), hashUserId('salt2', 'uid'));
  assert.match(hashUserId('salt', 'uid'), /^[0-9a-f]{64}$/);
});

test('tag type maps to event type', () => {
  assert.equal(eventTypeForTag({ tag_type: 'QUEUE' }), 'QUEUE_JOIN');
  assert.equal(eventTypeForTag({ tag_type: 'BUS' }), 'BUS_BOARD');
  assert.equal(eventTypeForTag({ tag_type: 'DRIVER' }), 'BUS_DEPART');
  assert.equal(eventTypeForTag({ tag_type: 'NOPE' }), null);
});

test('body validation', () => {
  const ok = parseTapBody({ event_id: '0b6f8a3e-2a1c-4c3e-9b1a-2f3d4e5f6a7b', tag_id: 'stopA-q1' });
  assert.equal(ok.value.offline_buffered, false);
  assert.ok(parseTapBody({ event_id: 'x', tag_id: 'stopA-q1' }).error);
  assert.ok(parseTapBody({ event_id: '0b6f8a3e-2a1c-4c3e-9b1a-2f3d4e5f6a7b', tag_id: '../etc' }).error);
  assert.ok(parseTapBody(null).error);
});

test('timestamp: live taps use server time, buffered taps keep phone time within 24h', () => {
  const tenMinAgo = new Date(NOW - 10 * MIN).toISOString();
  assert.equal(resolveTimestamp(tenMinAgo, false, NOW), new Date(NOW).toISOString());
  assert.equal(resolveTimestamp(tenMinAgo, true, NOW), tenMinAgo);
  assert.equal(resolveTimestamp(new Date(NOW + 60 * MIN).toISOString(), true, NOW), new Date(NOW).toISOString());
  assert.equal(resolveTimestamp(new Date(NOW - 25 * 60 * MIN).toISOString(), true, NOW), new Date(NOW).toISOString());
  assert.equal(resolveTimestamp('garbage', true, NOW), new Date(NOW).toISOString());
});

test('first QUEUE_JOIN accepted; second within 10 min rejected', () => {
  const a = applyAntiSpoof({ eventType: 'QUEUE_JOIN', eventMs: NOW, nowMs: NOW, state: null });
  assert.equal(a.reject, undefined);
  assert.equal(a.nextState.last_join_ms, NOW);
  const b = applyAntiSpoof({ eventType: 'QUEUE_JOIN', eventMs: NOW + 5 * MIN, nowMs: NOW + 5 * MIN, state: a.nextState });
  assert.equal(b.reject.code, 'ALREADY_IN_QUEUE');
  const c = applyAntiSpoof({
    eventType: 'QUEUE_JOIN',
    eventMs: NOW + QUEUE_COOLDOWN_MS,
    nowMs: NOW + QUEUE_COOLDOWN_MS,
    state: a.nextState,
  });
  assert.equal(c.reject, undefined);
});

test('BUS_BOARD after a join is clean and consumes the join', () => {
  const state = { recent_taps_ms: [], last_join_ms: NOW - 9 * MIN };
  const r = applyAntiSpoof({ eventType: 'BUS_BOARD', eventMs: NOW, nowMs: NOW, state });
  assert.equal(r.flagged, false);
  assert.equal(r.nextState.last_join_ms, null);
});

test('BUS_BOARD without a join in 60 min is accepted but flagged', () => {
  const none = applyAntiSpoof({ eventType: 'BUS_BOARD', eventMs: NOW, nowMs: NOW, state: null });
  assert.equal(none.reject, undefined);
  assert.equal(none.flagged, true);
  assert.equal(none.flag_reason, 'BOARD_WITHOUT_JOIN');
  const stale = applyAntiSpoof({
    eventType: 'BUS_BOARD',
    eventMs: NOW,
    nowMs: NOW,
    state: { recent_taps_ms: [], last_join_ms: NOW - 61 * MIN },
  });
  assert.equal(stale.flagged, true);
});

test('rate limit per ID', () => {
  const state = { recent_taps_ms: Array.from({ length: RATE_MAX }, (_, i) => NOW - i * 1000), last_join_ms: null };
  const r = applyAntiSpoof({ eventType: 'BUS_DEPART', eventMs: NOW, nowMs: NOW, state });
  assert.equal(r.reject.status, 429);
  const later = applyAntiSpoof({ eventType: 'BUS_DEPART', eventMs: NOW + 2 * MIN, nowMs: NOW + 2 * MIN, state });
  assert.equal(later.reject, undefined);
});
