// Gemini insights for the /dispatch dashboard. Server-side only (the API key never reaches the browser).
//
// Gemini gets a short list of aggregate facts (no IDs, no per-person rows) and writes a plain-English summary.
// It does not decide anything: the numbers and the bus recommendation come from BigQuery and recommend.js.
// Every number Gemini writes is checked against the facts; anything not found is reported as unchecked.
// No key or a failed call -> a fixed template built from the same facts, so the demo always works.

// Tried in order: if one is overloaded (503), rate-limited (429), missing (404) or slow, the next one is tried.
// Override with GEMINI_MODEL (one name or a comma-separated list).
const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest'];
const DEFAULT_MODEL = DEFAULT_MODELS[0];
// Total time for all attempts. Flash models "think" before answering; Vercel maxDuration is 60 s.
const TIMEOUT_MS = 50_000;
const TTL_OK_MS = 60 * 60 * 1000; // 1 h: the history changes once a day at most
const TTL_FALLBACK_MS = 5 * 60 * 1000; // retry Gemini sooner after a failure

const fmtH = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
const fmtDate = (d) =>
  !d ? null : new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-MY', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kuala_Lumpur',
  });
const CAPACITY = 40;

/** The only data Gemini sees: aggregates from the dashboard response. */
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
      biggest_effect_at: fmtH(r.impact_hour),
      wait_before_min: r.wait_before_min,
      wait_after_min: r.wait_after_min,
      left_behind_per_bus_before: r.left_behind_before,
      left_behind_per_bus_after: r.left_behind_after,
      person_hours_saved: r.person_hours_saved,
    })),
  };
}

/** Deterministic summary from the same facts. Used when Gemini is not configured or fails. */
export function templateSummary(f) {
  const w = f.longest_waits[0];
  const busiest = [...f.forecast_next_7_days].sort((a, b) => b.peak_people - a.peak_people)[0];
  const lb = f.most_left_behind_days[0];
  const r = f.recommended_changes[0];
  const points = [
    `Buses run ${f.overall.bus_fill_pct}% full on average, yet ${f.overall.left_behind_per_bus} people are left behind per bus: seats are in the wrong hours.`,
  ];
  if (busiest)
    points.push(
      `${busiest.day} ${busiest.peak_hour} is the busiest hour in the 7-day forecast: ${busiest.peak_people} people for ${busiest.peak_seats} seats.`,
    );
  if (lb) points.push(`${lb.day} left the most people behind: ${lb.left_behind_total.toLocaleString('en-MY')} in total, ${lb.worst_single_bus} after one bus.`);
  return {
    headline: w
      ? `${w.when} has the longest wait: ${w.avg_wait_min} min on average, and 1 in 10 people wait ${w.p90_wait_min} min or more.`
      : `Average wait is ${f.overall.avg_wait_min} min.`,
    points,
    action: r
      ? `Add ${r.add_buses} bus${r.add_buses > 1 ? 'es' : ''} at ${r.when} (${r.buses_now} → ${r.buses_now + r.add_buses}). The wait at ${r.biggest_effect_at} drops from ${r.wait_before_min} to ${r.wait_after_min} min and ${r.person_hours_saved} person-hours of waiting are saved.`
      : 'Keep the current timetable: no single change saves enough waiting in the next 7 days.',
  };
}

/** Numbers in the text that do not appear in the facts (a rounded value of a fact counts as found). */
export function uncheckedNumbers(summary, facts) {
  const nums = (s) => (s.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const known = new Set(nums(JSON.stringify(facts)));
  const rounded = new Set([...known].map(Math.round));
  // Small counts ("two buses", "top 3") and the 1-in-10 wording of p90 need no source.
  const ok = (n) => n <= 3 || n === 10 || n === 90 || known.has(n) || (Number.isInteger(n) && rounded.has(n));
  const text = [summary.headline, ...summary.points, summary.action].join(' ');
  return [...new Set(nums(text).filter((n) => !ok(n)))];
}

const SYSTEM = `You write a short briefing for the APU shuttle bus dispatcher at Stop A (Asia Pacific University, Kuala Lumpur).
The data is SIMULATED history and a BigQuery ML forecast. Times are Malaysia time.
Rules:
- Use only the facts given. Copy numbers exactly as written; do not calculate new numbers, percentages or differences.
- Plain English, short sentences, no jargon, no adverbs, no em dashes.
- headline: the single most important problem, one sentence.
- points: 3 short findings a dispatcher can act on (when, how bad, why it matters).
- action: the first recommended change, with its before and after numbers.
- Never mention individual students. Do not say the data is real.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    points: { type: 'ARRAY', items: { type: 'STRING' } },
    action: { type: 'STRING' },
  },
  required: ['headline', 'points', 'action'],
};

/** One call to the Gemini API (REST, no SDK). Throws on any problem. */
export async function askGemini(facts, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetchImpl(url, {
    method: 'POST',
    // Key in a header, not the URL, so it never shows up in request logs.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `Facts (JSON):\n${JSON.stringify(facts)}` }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  const out = JSON.parse(text);
  const points = Array.isArray(out.points) ? out.points.filter((p) => typeof p === 'string' && p.trim()).slice(0, 4) : [];
  if (typeof out.headline !== 'string' || typeof out.action !== 'string' || !points.length)
    throw new Error('Gemini returned an unexpected shape');
  return { summary: { headline: out.headline, points, action: out.action }, model: data.modelVersion || model };
}

let cache = null; // { at, ttl, data }

/** Summary for the dashboard: cached Gemini answer, or the template. */
export async function getInsights(dispatch, env = process.env, { fetchImpl } = {}) {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.data;
  const facts = buildFacts(dispatch);
  const base = { simulated: true, generated_at: new Date().toISOString(), data_source: dispatch.source };
  // Pasted or imported keys often carry quotes, spaces or a newline; Google rejects those.
  const apiKey = (env.GEMINI_API_KEY ?? '').trim().replace(/^["']|["']$/g, '').trim();
  let data;
  if (!apiKey) {
    data = { ...base, source: 'template', reason: 'Gemini is not set up', ...templateSummary(facts) };
  } else {
    const models = (env.GEMINI_MODEL || '').split(',').map((m) => m.trim()).filter(Boolean);
    const deadline = Date.now() + TIMEOUT_MS;
    const errors = [];
    for (const model of models.length ? models : DEFAULT_MODELS) {
      const left = deadline - Date.now();
      if (left < 3000) break;
      try {
        const { summary, model: used } = await askGemini(facts, { apiKey, model, fetchImpl, timeoutMs: left });
        data = { ...base, source: 'gemini', model: used, unchecked_numbers: uncheckedNumbers(summary, facts), ...summary };
        break;
      } catch (err) {
        console.warn(JSON.stringify({ severity: 'WARNING', msg: 'insights: model failed', model, err: String(err) }));
        // Google's error text (e.g. "API key not valid", "high demand") helps fix setup; never echo the key.
        errors.push(`${model}: ${String(err.message || err).split(apiKey).join('***').replace(/\s+/g, ' ').slice(0, 200)}`);
        if (/HTTP (400|401|403)\b/.test(String(err))) break; // bad key: other models will fail the same way
      }
    }
    if (!data) {
      console.warn(JSON.stringify({ severity: 'WARNING', msg: 'insights: using template' }));
      data = { ...base, source: 'template', reason: 'Gemini did not answer', error: errors.join(' | '), ...templateSummary(facts) };
    }
  }
  cache = { at: Date.now(), ttl: data.source === 'gemini' ? TTL_OK_MS : TTL_FALLBACK_MS, data };
  return data;
}

export function clearInsightsCache() {
  cache = null;
}
