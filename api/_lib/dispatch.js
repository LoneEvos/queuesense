// Data for the /dispatch dashboard: BigQuery views + forecast, plus the bus recommendation.
// Files under api/_lib are helpers, not Vercel functions (leading underscore).
//
// Order of sources: in-memory cache (10 min) -> BigQuery -> committed snapshot (sql/dispatch-snapshot.json).
// The snapshot keeps the dashboard working locally (no BigQuery credentials) and if the sandbox tables expire.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recommend } from '../../insights/recommend.js';

const DATASET = 'queuesense';
const LOCATION = 'asia-southeast1';
const TTL_MS = 10 * 60 * 1000;
const SNAPSHOT = fileURLToPath(new URL('../../sql/dispatch-snapshot.json', import.meta.url));

const QUERIES = {
  kpis: `SELECT * FROM ${DATASET}.v_kpis`,
  heatmap: `SELECT dow_idx, dow, hour, avg_wait_min, p90_wait_min, journeys
            FROM ${DATASET}.v_wait_heatmap ORDER BY dow_idx, hour`,
  left_behind_daily: `SELECT dep_date AS date, dow, left_behind_total, left_behind_per_bus, worst_bus
                      FROM ${DATASET}.v_left_behind_daily ORDER BY dep_date`,
  forecast: `SELECT f.slot_date AS date, f.dow, f.dow_idx, f.hour,
                    f.forecast_joins, f.joins_low, f.joins_high, f.buses_needed,
                    CAST(ROUND(IFNULL(b.buses_per_hour, 0)) AS INT64) AS scheduled_buses,
                    b.fill_pct, b.left_behind_per_bus AS hist_left_behind_per_bus,
                    w.avg_wait_min AS hist_avg_wait_min
             FROM ${DATASET}.forecasts AS f
             LEFT JOIN ${DATASET}.v_bus_slots AS b USING (dow_idx, hour)
             LEFT JOIN ${DATASET}.v_wait_heatmap AS w USING (dow_idx, hour)
             ORDER BY f.slot_date, f.hour`,
};

let cache = null; // { at, data }

export async function getDispatch({ credentials } = {}) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  let data;
  try {
    if (!credentials) throw new Error('no BigQuery credentials');
    data = shape(await queryAll(credentials), 'bigquery');
  } catch (err) {
    console.warn(JSON.stringify({ severity: 'WARNING', msg: 'dispatch: using snapshot', err: String(err) }));
    data = { ...readSnapshot(), source: 'snapshot' };
  }
  cache = { at: Date.now(), data };
  return data;
}

async function queryAll(credentials) {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const bq = new BigQuery({ projectId: credentials.project_id, credentials, location: LOCATION });
  const entries = await Promise.all(
    Object.entries(QUERIES).map(async ([k, sql]) => {
      const [rows] = await bq.query({ query: sql, location: LOCATION });
      return [k, rows.map(plain)];
    }),
  );
  return Object.fromEntries(entries);
}

/** Build the response: no service in a slot means no forecast demand there. */
export function shape(raw, source) {
  const forecast = raw.forecast.map((f) =>
    f.scheduled_buses > 0 ? f : { ...f, forecast_joins: 0, joins_low: 0, joins_high: 0, buses_needed: 0 },
  );
  return {
    source,
    generated_at: new Date().toISOString(),
    simulated: true,
    kpis: raw.kpis[0] ?? null,
    heatmap: raw.heatmap,
    left_behind_daily: raw.left_behind_daily,
    forecast,
    recommendations: recommend(forecast),
  };
}

function readSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
}

// BigQuery returns DATE/TIMESTAMP as objects with .value and numerics as numbers or Big; flatten to JSON.
function plain(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && 'value' in v) out[k] = v.value;
    else if (v && typeof v === 'object' && typeof v.toNumber === 'function') out[k] = v.toNumber();
    else out[k] = v;
  }
  return out;
}
