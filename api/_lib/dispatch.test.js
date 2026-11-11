import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shape, todayMYT } from './dispatch.js';

const s = JSON.parse(readFileSync(new URL('../../sql/dispatch-snapshot.json', import.meta.url), 'utf8'));
const raw = { kpis: [s.kpis], heatmap: s.heatmap, left_behind_daily: s.left_behind_daily, forecast: s.forecast };
const days = (d) => [...new Set(d.forecast.map((f) => f.date))];

test('Malaysia date rolls over at 16:00 UTC', () => {
  assert.equal(todayMYT(Date.parse('2026-11-12T15:59:00Z')), '2026-11-12');
  assert.equal(todayMYT(Date.parse('2026-11-12T16:00:00Z')), '2026-11-13');
});

test('past forecast days are dropped, recommendations only for today onwards', () => {
  const d = shape(raw, 'snapshot', '2026-11-13');
  assert.equal(d.forecast_stale, false);
  assert.deepEqual(days(d), ['2026-11-13', '2026-11-14', '2026-11-15']);
  assert.ok(d.recommendations.length > 0);
  assert.ok(d.recommendations.every((r) => r.slot_date >= '2026-11-13'));
});

test('a forecast with no days left is shown whole and flagged stale', () => {
  const d = shape(raw, 'snapshot', '2026-11-17');
  assert.equal(d.forecast_stale, true);
  assert.equal(days(d).length, 7);
});

test('only a 7-day window is kept from a longer forecast', () => {
  const d = shape(raw, 'snapshot', '2026-11-09');
  assert.deepEqual(days(d), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(shape(raw, 'snapshot', '2026-11-12').forecast.every((f) => f.date < '2026-11-19'), true);
});
