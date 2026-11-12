// AI summary for the /dispatch dashboard. Server-side only.
//
// The model gets a short list of aggregate facts (no IDs, no per-person rows) and returns strict JSON:
// a 3-sentence summary for APU management, the top 3 actions with reasons, and one caveat.
// It does not decide anything: the numbers and the bus recommendation come from BigQuery and recommend.js.
// Every number it writes is checked against the facts; anything not found is reported as unchecked.
// All model access goes through ai-provider.js (AI_PROVIDER switch). No provider, a failed call or an
// invalid answer -> a fixed template built from the same facts, so the demo always works.
// Results are cached (1 h, or 5 min after a failure), and the API response is CDN-cached, so page loads
// do not call the model.
import { generateJson, NotConfigured } from './ai-provider.js';

const TTL_OK_MS = 60 * 60 * 1000; // 1 h: the history changes once a day at most
const TTL_FALLBACK_MS = 5 * 60 * 1000; // retry the model sooner after a failure
const CAPACITY = 40;

const fmtH = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
const fmtDate = (d) =>
  !d
    ? null
    : new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-MY', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'Asia/Kuala_Lumpur',
      });

/** The only data the model sees: aggregates from the dashboard response. */
export function buildFacts(input) {
  // Missing pieces (no history, no forecast yet) become empty lists, so the summary never crashes.
  const d = {
    ...input,
    heatmap: input.heatmap ?? [],
    left_behind_daily: input.left_behind_daily ?? [],
    forecast: input.forecast ?? [],
    recommendations: input.recommendations ?? [],
  };
  const k = d.kpis ?? {};
  const slots = [...d.heatmap].sort((a, b) => b.avg_wait_min - a.avg_wait_min);
  const days = [...new Set(d.forecast.filter((f) => f.scheduled_buses > 0).map((f) => f.date))];
  return {
    simulated: true,
    history: { from: fmtDate(k.from_date), to: fmtDate(k.to_date), journeys: k.journeys, bus_trips: k.trips },
    overall: {
      avg_wait_min: k.avg_wait_min,
      p90_wait_min: k.p90_wait_min,
      left_behind_per_bus: k.avg_left_behind_per_bus,
      bus_fill_pct: k.avg_fill_pct,
    },
    longest_waits: slots.slice(0, 3).map((s) => ({
      when: `${s.dow} ${fmtH(s.hour)}`,
      avg_wait_min: s.avg_wait_min,
      p90_wait_min: s.p90_wait_min,
    })),
    shortest_waits: slots
      .filter((s) => s.journeys >= 100)
      .slice(-2)
      .map((s) => ({ when: `${s.dow} ${fmtH(s.hour)}`, avg_wait_min: s.avg_wait_min })),
    most_left_behind_days: [...d.left_behind_daily]
      .sort((a, b) => b.left_behind_total - a.left_behind_total)
      .slice(0, 2)
      .map((r) => ({ day: fmtDate(r.date), left_behind_total: r.left_behind_total, worst_single_bus: r.worst_bus })),
    forecast_next_7_days: days.map((date) => {
      const rows = d.forecast.filter((f) => f.date === date && f.scheduled_buses > 0);
      const peak = rows.reduce((m, r) => (r.forecast_joins > m.forecast_joins ? r : m), rows[0]);
      return {
        day: fmtDate(date),
        people_forecast: rows.reduce((s, r) => s + r.forecast_joins, 0),
        peak_hour: fmtH(peak.hour),
        peak_people: peak.forecast_joins,
        peak_seats: peak.scheduled_buses * CAPACITY,
      };
    }),
    recommended_changes: d.recommendations.slice(0, 3).map((r) => ({
      when: `${fmtDate(r.slot_date)} ${fmtH(r.hour)}`,
      add_buses: r.add_buses,
      buses_now: r.scheduled_buses,
      buses_after: r.scheduled_buses + r.add_buses,
      biggest_effect_at: fmtH(r.impact_hour),
      wait_before_min: r.wait_before_min,
      wait_after_min: r.wait_after_min,
      left_behind_per_bus_before: r.left_behind_before,
      left_behind_per_bus_after: r.left_behind_after,
      person_hours_saved: r.person_hours_saved,
    })),
  };
}

const CAVEAT =
  'These numbers come from simulated history and a BigQuery ML forecast, not real student taps yet, so treat them as estimates.';

/** Deterministic summary from the same facts. Used when no AI provider is set up or the call fails. */
export function templateSummary(f) {
  const o = f.overall;
  const w = f.longest_waits[0];
  const busiest = [...f.forecast_next_7_days].sort((a, b) => b.peak_people - a.peak_people)[0];
  const lb = f.most_left_behind_days[0];

  const sentences = [];
  if (w) sentences.push(`${w.when} has the longest wait: ${w.avg_wait_min} min on average, and 1 in 10 people wait ${w.p90_wait_min} min or more.`);
  else sentences.push('There is no wait history yet, so there is no longest wait to report.');
  if (o.bus_fill_pct != null)
    sentences.push(`Buses run ${o.bus_fill_pct}% full on average, yet ${o.left_behind_per_bus} people are left behind per bus, so seats are in the wrong hours.`);
  else sentences.push('Bus fill and left-behind numbers appear once there are departures to measure.');
  if (busiest) sentences.push(`${busiest.day} ${busiest.peak_hour} is the busiest hour in the next 7 days: ${busiest.peak_people} people for ${busiest.peak_seats} seats.`);
  else sentences.push('No forecast is loaded for the next 7 days.');

  const actions = f.recommended_changes.map((r) => ({
    action: `Add ${r.add_buses} bus${r.add_buses > 1 ? 'es' : ''} at ${r.when} (${r.buses_now} → ${r.buses_after}).`,
    reason: `The wait at ${r.biggest_effect_at} drops from ${r.wait_before_min} to ${r.wait_after_min} min and ${r.person_hours_saved} person-hours of waiting are saved.`,
  }));
  const extra = [
    busiest && {
      action: `Have a standby bus ready for ${busiest.day} ${busiest.peak_hour}.`,
      reason: `The forecast is ${busiest.peak_people} people for ${busiest.peak_seats} seats in that hour.`,
    },
    lb && {
      action: `Review what went wrong on ${lb.day}.`,
      reason: `${lb.left_behind_total.toLocaleString('en-MY')} people were left behind that day, ${lb.worst_single_bus} after one bus.`,
    },
    !f.recommended_changes.length && {
      action: 'Keep the current timetable.',
      reason: 'No single extra bus saves enough waiting in the next 7 days.',
    },
    {
      action: 'Ask students to tap the queue sticker when they join.',
      reason: 'More queue taps make the wait and left-behind numbers more accurate.',
    },
    {
      action: 'Load the real sticker taps into the BigQuery history.',
      reason: 'Real taps already drive the live count; adding them to the history makes the forecast match reality.',
    },
  ].filter(Boolean);
  return { summary: sentences.join(' '), actions: [...actions, ...extra].slice(0, 3), caveat: CAVEAT };
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const sentenceCount = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean).length;

/** Strict check of the model's JSON. Returns a clean copy or throws (then the next model or the template is used). */
export function validateSummary(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('answer is not a JSON object');
  const summary = str(o.summary, 800);
  if (!summary) throw new Error('summary is missing');
  const n = sentenceCount(summary);
  if (n < 2 || n > 4) throw new Error(`summary has ${n} sentences, expected 3`);
  const actions = (Array.isArray(o.actions) ? o.actions : [])
    .map((a) => ({ action: str(a?.action, 240), reason: str(a?.reason, 320) }))
    .filter((a) => a.action && a.reason);
  if (actions.length < 3) throw new Error(`expected 3 actions with reasons, got ${actions.length}`);
  const caveat = str(o.caveat, 320);
  if (!caveat) throw new Error('caveat is missing');
  return { summary, actions: actions.slice(0, 3), caveat };
}

/** Numbers in the text that do not appear in the facts (a rounded value of a fact counts as found). */
export function uncheckedNumbers(s, facts) {
  const nums = (t) => (t.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = new Set(nums(JSON.stringify(facts)));
  const rounded = new Set([...known].map(Math.round));
  // Small counts ("two buses", "top 3"), "7 days" and the 1-in-10 wording of p90 need no source.
  const ok = (n) => n <= 3 || n === 7 || n === 10 || n === 90 || known.has(n) || (Number.isInteger(n) && rounded.has(n));
  const text = [s.summary, ...s.actions.flatMap((a) => [a.action, a.reason]), s.caveat].join(' ');
  return [...new Set(nums(text).filter((n) => !ok(n)))];
}

const SYSTEM = `You write a short briefing for APU management about the shuttle bus queue at Stop A (Asia Pacific University, Kuala Lumpur).
The data is SIMULATED history and a BigQuery ML forecast. Times are Malaysia time.
Rules:
- Use only the facts given. Copy numbers exactly as written; do not calculate new numbers, percentages or differences.
- Plain English, short sentences, no jargon, no adverbs, no em dashes.
- Write values as normal words ("from 6 to 8 buses"); never write the JSON field names. Say p90 as "1 in 10 people wait X min or more".
- summary: exactly 3 sentences on the most important problems (when, how bad, why it matters).
- actions: exactly 3, most useful first. Each has "action" (what to do, one sentence) and "reason" (the numbers behind it, one sentence). Start with the recommended changes, using their before and after numbers.
- caveat: one sentence on the main limit of this data.
- Never mention individual students. Do not say the data is real.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    actions: {
      type: 'ARRAY',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'OBJECT',
        properties: { action: { type: 'STRING' }, reason: { type: 'STRING' } },
        required: ['action', 'reason'],
      },
    },
    caveat: { type: 'STRING' },
  },
  required: ['summary', 'actions', 'caveat'],
};

let cache = null; // { at, ttl, data }

/** Summary for the dashboard: cached model answer, or the template. */
export async function getInsights(dispatch, env = process.env, opts = {}) {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.data;
  const facts = buildFacts(dispatch);
  const base = { simulated: true, generated_at: new Date().toISOString(), data_source: dispatch.source };
  let data;
  try {
    const { value, model, provider } = await generateJson(
      { system: SYSTEM, prompt: `Facts (JSON):\n${JSON.stringify(facts)}`, schema: SCHEMA, validate: validateSummary },
      env,
      opts,
    );
    data = { ...base, source: 'gemini', provider, model, unchecked_numbers: uncheckedNumbers(value, facts), ...value };
  } catch (err) {
    const setup = err instanceof NotConfigured;
    if (!setup) console.warn(JSON.stringify({ severity: 'WARNING', msg: 'insights: using template' }));
    data = {
      ...base,
      source: 'template',
      reason: setup ? err.message : 'The AI model did not answer',
      ...(setup ? {} : { error: String(err.message || err) }),
      ...templateSummary(facts),
    };
  }
  cache = { at: Date.now(), ttl: data.source === 'gemini' ? TTL_OK_MS : TTL_FALLBACK_MS, data };
  return data;
}

export function clearInsightsCache() {
  cache = null;
}
