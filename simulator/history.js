#!/usr/bin/env node
// Synthetic history generator. Writes several weeks of SIMULATED journeys, bus trips and
// queue snapshots for one stop, as CSV files ready to load into BigQuery.
//
//   node simulator/history.js                     6 weeks ending last Sunday, seed 42
//   node simulator/history.js --weeks 8 --seed 7 --out simulator/out
//
// The pattern it builds in (so the dashboard has something real to find):
//   - morning peak around 7:45-8:15, smaller midday and evening peaks
//   - Mondays about 35% busier than other weekdays; Fridays quieter; light Saturdays; no Sunday service
//   - exam weeks (last 2 weeks): about 25% busier and the morning peak starts earlier
//   - rainy days (about 1 in 4 weekdays): +40% demand in the rain window, and some buses run late
//   - the current timetable is deliberately too thin for Monday mornings, so queues build and people are left behind
//
// Every row has simulated = true. Times are stored in UTC; service hours are defined in Malaysia time (UTC+8).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- options ----------
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const WEEKS = Number(arg('weeks', 6));
const SEED = Number(arg('seed', 42));
const OUT = arg('out', 'simulator/out');
const STOP = 'stopA';
const CAPACITY = 40;
const ABANDON_MIN = 60; // people give up after an hour
const MYT_OFFSET_H = 8;

// ---------- seeded randomness (reproducible) ----------
let s = SEED >>> 0;
function rand() {
  // mulberry32
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function poisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;

// ---------- calendar ----------
// Last full Mon-Sun week ending before today (Malaysia time), going back WEEKS weeks.
function startMonday() {
  const nowMyt = new Date(Date.now() + MYT_OFFSET_H * 3600e3);
  const d = new Date(Date.UTC(nowMyt.getUTCFullYear(), nowMyt.getUTCMonth(), nowMyt.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow - 7 * WEEKS); // Monday WEEKS weeks before this week's Monday
  return d;
}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ymd = (d) => d.toISOString().slice(0, 10);
// Malaysia wall-clock (date + minutes since midnight) -> UTC ISO string
const toUtc = (dayUtcMidnight, minuteOfDay, sec = 0) =>
  new Date(dayUtcMidnight.getTime() + (minuteOfDay - MYT_OFFSET_H * 60) * 60e3 + sec * 1e3).toISOString();

// ---------- demand model (arrivals per minute) ----------
const bump = (m, centre, sd, height) => height * Math.exp(-((m - centre) ** 2) / (2 * sd * sd));
function arrivalRate(minute, ctx) {
  const morningCentre = ctx.exam ? 7 * 60 + 35 : 7 * 60 + 55;
  let r =
    0.5 +
    bump(minute, morningCentre, 32, 5.3) +
    bump(minute, 12 * 60 + 30, 40, 2.2) +
    bump(minute, 15 * 60, 40, 1.6) +
    bump(minute, 17 * 60 + 30, 45, 2.6);
  r *= ctx.dayFactor;
  if (ctx.exam) r *= 1.25;
  if (ctx.rain && minute >= ctx.rain.start && minute < ctx.rain.end) r *= 1.4;
  return r;
}

// ---------- current (too thin) timetable ----------
function departures(dow, ctx) {
  if (dow === 6) return []; // no Sunday service
  const [open, close] = dow === 5 ? [8 * 60, 14 * 60] : [7 * 60, 20 * 60];
  const out = [];
  for (let m = open + 10; m <= close; ) {
    out.push(m);
    const peak = m >= 7 * 60 + 30 && m < 9 * 60;
    m += peak ? 8 : 12; // every 8 min in the morning peak, else every 12
  }
  // Rain: about 1 in 5 buses in the rain window runs 6-10 min late.
  return out.map((m) =>
    ctx.rain && m >= ctx.rain.start && m < ctx.rain.end && rand() < 0.2 ? m + 6 + Math.floor(rand() * 5) : m,
  );
}

// ---------- simulate ----------
const journeys = [];
const trips = [];
const snapshots = [];
const days = [];
const start = startMonday();
const buses = ['bus01', 'bus02', 'bus03', 'bus04'];
let busTurn = 0;

for (let i = 0; i < WEEKS * 7; i++) {
  const day = new Date(start.getTime() + i * 86400e3);
  const dow = i % 7;
  const week = Math.floor(i / 7);
  const exam = week >= WEEKS - 2;
  const isRain = dow < 6 && rand() < 0.25;
  const rainStart = isRain ? (rand() < 0.35 ? 7 * 60 : 14 * 60 + Math.floor(rand() * 120)) : null;
  const ctx = {
    exam,
    rain: isRain ? { start: rainStart, end: rainStart + 120 + Math.floor(rand() * 90) } : null,
    dayFactor: [1.25, 1.0, 1.0, 0.95, 0.85, 0.35, 0][dow],
  };
  days.push({
    date: ymd(day),
    day_of_week: DOW[dow],
    is_exam_week: exam,
    is_rain: isRain,
    rain_start_myt: isRain ? hhmm(ctx.rain.start) : '',
    rain_end_myt: isRain ? hhmm(ctx.rain.end) : '',
    simulated: true,
  });

  const deps = departures(dow, ctx).sort((a, b) => a - b);
  if (!deps.length) continue;
  const open = deps[0] - 10;
  const close = deps[deps.length - 1];
  const queue = []; // FIFO of { joinSec } (seconds since midnight MYT)
  let d = 0;

  for (let m = open; m <= close; m++) {
    // arrivals during this minute
    const k = m < close - 5 ? poisson(arrivalRate(m, ctx)) : 0;
    const joins = Array.from({ length: k }, () => m * 60 + Math.floor(rand() * 60)).sort((a, b) => a - b);
    for (const joinSec of joins) queue.push({ joinSec, pos: queue.length + 1 });

    // people who have waited an hour give up
    while (queue.length && m * 60 - queue[0].joinSec > ABANDON_MIN * 60) queue.shift();

    // departures this minute
    while (d < deps.length && deps[d] === m) {
      const busId = buses[busTurn++ % buses.length];
      const depSec = m * 60 + 50;
      const boarding = queue.splice(0, CAPACITY);
      boarding.forEach((p, idx) => {
        const boardSec = Math.max(p.joinSec + 5, depSec - 120 + Math.floor(rand() * 110));
        journeys.push({
          journey_id: uuid(),
          hashed_user_id: hex(64),
          stop_id: STOP,
          bus_id: busId,
          queue_join_ts: toUtc(day, 0, p.joinSec),
          board_ts: toUtc(day, 0, boardSec),
          wait_seconds: boardSec - p.joinSec,
          queue_position_at_join: p.pos,
          boarding_order: idx + 1,
          simulated: true,
        });
      });
      trips.push({
        trip_id: uuid(),
        bus_id: busId,
        stop_id: STOP,
        departure_ts: toUtc(day, 0, depSec),
        capacity: CAPACITY,
        boarded_count: boarding.length,
        left_behind_count: queue.length,
        simulated: true,
      });
      // positions shift up for everyone still waiting
      queue.forEach((p, idx) => (p.pos = idx + 1));
      d++;
    }
    snapshots.push({ stop_id: STOP, snapshot_ts: toUtc(day, m, 59), queue_length: queue.length, simulated: true });
  }
}

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ---------- write CSV ----------
function csv(rows) {
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n';
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'matched_journeys.csv'), csv(journeys));
writeFileSync(join(OUT, 'bus_trips.csv'), csv(trips));
writeFileSync(join(OUT, 'queue_snapshots.csv'), csv(snapshots));
writeFileSync(join(OUT, 'day_context.csv'), csv(days));

// ---------- summary (sanity check of the built-in patterns) ----------
const mytHour = (iso) => (new Date(iso).getUTCHours() + MYT_OFFSET_H) % 24;
const mytDow = (iso) => (new Date(new Date(iso).getTime() + MYT_OFFSET_H * 3600e3).getUTCDay() + 6) % 7;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (a, q) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(q * (b.length - 1))];
};

console.log(`SIMULATED history: ${days[0].date} to ${days.at(-1).date} (${WEEKS} weeks, seed ${SEED})`);
console.log(`journeys ${journeys.length}  trips ${trips.length}  snapshots ${snapshots.length}  -> ${OUT}/`);
const waits = journeys.map((j) => j.wait_seconds / 60);
console.log(`wait min: avg ${avg(waits).toFixed(1)}  p90 ${pct(waits, 0.9).toFixed(1)}`);

console.log('\nAverage wait (min) by day and hour, Malaysia time:');
const hours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
console.log('     ' + hours.map((h) => String(h).padStart(5)).join(''));
for (let dw = 0; dw < 6; dw++) {
  const row = hours.map((h) => {
    const w = journeys.filter((j) => mytDow(j.queue_join_ts) === dw && mytHour(j.queue_join_ts) === h).map((j) => j.wait_seconds / 60);
    return (w.length ? avg(w).toFixed(1) : '-').padStart(5);
  });
  console.log(DOW[dw].padEnd(5) + row.join(''));
}
const leftBy = (dw) => avg(trips.filter((t) => mytDow(t.departure_ts) === dw).map((t) => t.left_behind_count));
console.log('\nAvg left behind per bus: ' + DOW.slice(0, 6).map((n, dw) => `${n} ${leftBy(dw).toFixed(1)}`).join('  '));
const fill = avg(trips.map((t) => t.boarded_count / t.capacity));
console.log(`Avg bus fill: ${(fill * 100).toFixed(0)}%`);
const examW = avg(journeys.filter((j) => days.find((d) => d.date === ymd(new Date(new Date(j.queue_join_ts).getTime() + 8 * 3600e3)))?.is_exam_week).map((j) => j.wait_seconds / 60));
console.log(`Exam weeks avg wait: ${examW.toFixed(1)} min vs overall ${avg(waits).toFixed(1)} min`);
