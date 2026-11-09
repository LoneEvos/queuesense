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
  assert.equal(rec.impact_hour, 8); // the 8am joiners gain most once the 7am backlog clears
  assert.ok(rec.wait_after_min < rec.wait_before_min - 3);
  assert.ok(rec.left_behind_after < rec.left_behind_before);
  assert.ok(rec.person_hours_saved >= 10);
});

test('a day with a morning and an evening overload gets a recommendation for each', () => {
  const both = [
    ...day,
    { slot_date: '2026-11-09', dow: 'Mon', hour: 16, forecast_joins: 150, scheduled_buses: 5 },
    { slot_date: '2026-11-09', dow: 'Mon', hour: 17, forecast_joins: 300, scheduled_buses: 5 },
    { slot_date: '2026-11-09', dow: 'Mon', hour: 18, forecast_joins: 150, scheduled_buses: 5 },
  ];
  const recs = recommend(both);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.hour < 12).sort(), [false, true]);
});

test('quiet days get no recommendation', () => {
  const quiet = day.map((d) => ({ ...d, forecast_joins: 40 }));
  assert.deepEqual(recommend(quiet), []);
});

test('accepts the API field name "date" and keeps days separate', () => {
  const twoDays = [
    ...day.map(({ slot_date, ...d }) => ({ ...d, date: '2026-11-09' })),
    ...day.map(({ slot_date, ...d }) => ({ ...d, date: '2026-11-10', forecast_joins: 40 })),
  ];
  const recs = recommend(twoDays);
  assert.ok(recs.length >= 1);
  assert.ok(recs.every((r) => r.slot_date === '2026-11-09'), 'the quiet day gets nothing');
  assert.equal(recs[0].hour, 7);
});
