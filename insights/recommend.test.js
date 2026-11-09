import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, simulateDay } from './recommend.js';

// A Monday-like day: heavy 7am, normal elsewhere.
const day = [
  { slot_date: '2026-11-09', dow: 'Mon', hour: 6, forecast_joins: 20, scheduled_buses: 0 },
  { slot_date: '2026-11-09', dow: 'Mon', hour: 7, forecast_joins: 460, scheduled_buses: 6 },
  { slot_date: '2026-11-09', dow: 'Mon', hour: 8, forecast_joins: 200, scheduled_buses: 7 },
  { slot_date: '2026-11-09', dow: 'Mon', hour: 9, forecast_joins: 120, scheduled_buses: 5 },
  { slot_date: '2026-11-09', dow: 'Mon', hour: 10, forecast_joins: 60, scheduled_buses: 5 },
];

test('enough capacity means short waits and nobody left behind', () => {
  const r = simulateDay([{ hour: 10, forecast_joins: 60, scheduled_buses: 5 }]);
  assert.ok(r[0].avg_wait_min < 12);
  assert.equal(r[0].left_behind_per_bus, 0);
});

test('demand above capacity builds a queue and leaves people behind', () => {
  const r = simulateDay(day.slice(1));
  const seven = r.find((x) => x.hour === 7);
  assert.ok(seven.avg_wait_min > 15, `7am wait ${seven.avg_wait_min}`);
  assert.ok(seven.left_behind_per_bus > 20);
});

test('adding buses at the worst hour cuts the wait', () => {
  const before = simulateDay(day.slice(1)).find((x) => x.hour === 7);
  const after = simulateDay(day.slice(1), { 7: 2 }).find((x) => x.hour === 7);
  assert.ok(after.avg_wait_min < before.avg_wait_min);
  assert.ok(after.left_behind_per_bus < before.left_behind_per_bus);
});

test('recommend targets the 7am overload, since its backlog causes the 8am waits', () => {
  const [rec] = recommend(day);
  assert.equal(rec.hour, 7);
  assert.ok(rec.add_buses >= 1 && rec.add_buses <= 3);
  assert.equal(rec.peak_hour, 8);
  assert.ok(rec.peak_wait_after_min < rec.peak_wait_before_min - 3);
  assert.ok(rec.left_behind_after < rec.left_behind_before);
  assert.ok(rec.person_hours_saved > 0);
});

test('quiet days get no recommendation', () => {
  const quiet = day.map((d) => ({ ...d, forecast_joins: 40 }));
  assert.deepEqual(recommend(quiet), []);
});
