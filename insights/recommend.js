// Bus deployment recommender. Pure and deterministic: the numbers come from here, not from Gemini.
//
// For one day, it replays the forecast demand minute by minute through a FIFO queue served by the
// timetable (buses of 40, evenly spaced in each hour), then tries adding buses to the worst hour
// and measures what that does to wait times and people left behind.

export const CAPACITY = 40;
const ABANDON_MIN = 60;

/**
 * slots: [{ hour, forecast_joins, scheduled_buses }] for one day (hours in Malaysia time).
 * extra: { [hour]: number of extra buses in that hour }
 * Returns per-hour { hour, avg_wait_min, left_behind_per_bus, joins, buses }.
 */
export function simulateDay(slots, extra = {}) {
  const byHour = new Map(slots.map((s) => [s.hour, s]));
  const hours = slots.map((s) => s.hour).sort((a, b) => a - b);
  if (!hours.length) return [];
  const first = hours[0] * 60;
  const last = (hours.at(-1) + 1) * 60;

  // Arrivals: spread each hour's demand evenly over its 60 minutes (fractional people are fine).
  // Departures: n buses in an hour leave at evenly spaced minutes.
  const departures = new Map();
  for (const h of hours) {
    const n = Math.max(0, Math.round((byHour.get(h).scheduled_buses ?? 0) + (extra[h] ?? 0)));
    for (let i = 0; i < n; i++) {
      const m = h * 60 + Math.floor(((i + 1) * 60) / (n + 1));
      departures.set(m, (departures.get(m) ?? 0) + 1);
    }
  }

  const queue = []; // [{ t: joinMinute, n: people }]
  const stats = new Map(hours.map((h) => [h, { waitSum: 0, boarded: 0, left: 0, deps: 0, joins: 0 }]));
  for (let m = first; m < last; m++) {
    const h = Math.floor(m / 60);
    const perMin = (byHour.get(h)?.forecast_joins ?? 0) / 60;
    if (perMin > 0) {
      queue.push({ t: m, n: perMin });
      stats.get(h).joins += perMin;
    }
    while (queue.length && m - queue[0].t > ABANDON_MIN) queue.shift();

    for (let b = 0; b < (departures.get(m) ?? 0); b++) {
      let seats = CAPACITY;
      while (seats > 0 && queue.length) {
        const g = queue[0];
        const take = Math.min(seats, g.n);
        const s = stats.get(Math.floor(g.t / 60)) ?? stats.get(h);
        s.waitSum += take * (m - g.t);
        s.boarded += take;
        g.n -= take;
        seats -= take;
        if (g.n <= 1e-9) queue.shift();
      }
      const st = stats.get(h);
      st.deps += 1;
      st.left += queue.reduce((x, g) => x + g.n, 0);
    }
  }

  return hours.map((h) => {
    const s = stats.get(h);
    return {
      hour: h,
      joins: Math.round(s.joins),
      buses: s.deps,
      avg_wait_min: s.boarded ? round1(s.waitSum / s.boarded) : 0,
      left_behind_per_bus: s.deps ? round1(s.left / s.deps) : 0,
    };
  });
}

/**
 * Pick the most useful extra buses for each day in the forecast.
 * forecast: [{ slot_date, dow, hour, forecast_joins, scheduled_buses }]
 * Returns recommendations sorted by minutes saved, with before/after numbers for the target hour.
 */
export function recommend(
  forecast,
  { maxExtra = 2, maxPerDay = 2, minPersonHours = 10, minSavingMin = 3 } = {},
) {
  const days = groupBy(forecast.filter((f) => (f.scheduled_buses ?? 0) > 0), (f) => f.slot_date ?? f.date);
  const recs = [];
  for (const [date, slots] of days) {
    const people = slots.reduce((s, r) => s + r.forecast_joins, 0);
    const extras = {}; // buses already recommended for this day
    // Greedy: find the best change, apply it, then look again (e.g. one for the morning, one for the evening).
    for (let k = 0; k < maxPerDay; k++) {
      const base = simulateDay(slots, extras);
      const dayBefore = weightedWait(base);
      let best = null;
      for (const s of slots) {
        if (s.forecast_joins < 60 || extras[s.hour]) continue;
        for (let add = 1; add <= maxExtra; add++) {
          const after = simulateDay(slots, { ...extras, [s.hour]: add });
          const savedPersonMin = (dayBefore - weightedWait(after)) * people;
          const perBus = savedPersonMin / add;
          // A bus added early can clear a backlog that hurts later hours, so score by waiting saved
          // across the whole day per extra bus. A second bus in the same hour must add 20% more saving.
          const better =
            !best ||
            perBus > best.perBus * 1.05 ||
            (best.hour === s.hour && savedPersonMin > best.savedPersonMin * 1.2);
          if (better) best = { hour: s.hour, add, perBus, savedPersonMin, base, after, slot: s };
        }
      }
      if (!best || best.savedPersonMin / 60 < minPersonHours) break;

      // Headline numbers: the hour this change helps most (often a later hour, once a backlog clears).
      const gains = best.base.map((b, i) => ({ b, a: best.after[i], gain: b.avg_wait_min - best.after[i].avg_wait_min }));
      const top = gains.sort((x, y) => y.gain - x.gain)[0];
      if (top.gain < minSavingMin) break;

      extras[best.hour] = best.add;
      recs.push({
        slot_date: date,
        dow: slots[0].dow,
        hour: best.hour,
        add_buses: best.add,
        scheduled_buses: best.slot.scheduled_buses,
        forecast_joins: best.slot.forecast_joins,
        forecast_people_day: Math.round(people),
        impact_hour: top.b.hour,
        wait_before_min: top.b.avg_wait_min,
        wait_after_min: top.a.avg_wait_min,
        left_behind_before: top.b.left_behind_per_bus,
        left_behind_after: top.a.left_behind_per_bus,
        day_wait_before_min: dayBefore,
        day_wait_after_min: weightedWait(best.after),
        person_hours_saved: Math.round(best.savedPersonMin / 60),
      });
    }
  }
  return recs.sort((a, b) => b.person_hours_saved - a.person_hours_saved);
}

function weightedWait(rows) {
  const n = rows.reduce((s, r) => s + r.joins, 0);
  return n ? round1(rows.reduce((s, r) => s + r.avg_wait_min * r.joins, 0) / n) : 0;
}
function groupBy(a, key) {
  const m = new Map();
  for (const x of a) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}
const round1 = (x) => Math.round(x * 10) / 10;
