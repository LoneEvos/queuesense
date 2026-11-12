import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ABANDON_MIN, CAPACITY, simulateDay } from '../../../insights/recommend.js';
import { useStop } from '../live.js';
import { formatMYT, stopInfo } from '../tags.js';
import StopSwitch from '../StopSwitch.jsx';

// Management dashboard. Everything here is aggregates of SIMULATED history (labelled on screen).
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7:00 - 20:00
const fmtH = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
const fmtDate = (d) =>
  new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kuala_Lumpur' });

// Sequential wait scale (one hue, light -> dark). Bins in minutes.
const BINS = [
  { max: 5, label: '< 5', step: 1 },
  { max: 10, label: '5–10', step: 2 },
  { max: 15, label: '10–15', step: 3 },
  { max: 20, label: '15–20', step: 4 },
  { max: 30, label: '20–30', step: 5 },
  { max: Infinity, label: '30+', step: 6 },
];
const binOf = (m) => BINS.find((b) => m < b.max);

export default function Dispatch() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    fetch('/api/dispatch')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData, (e) => setError(String(e.message || e)));
  }, [attempt]);

  if (error && !data) {
    return (
      <main className="dash">
        <section className="errstate" role="alert">
          <h2>The dashboard data didn't load</h2>
          <p>The analytics server didn't answer ({error}). The live queue and taps are not affected.</p>
          <button className="secondary" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
          <Link to="/">Open the live queue</Link>
        </section>
      </main>
    );
  }
  if (!data) return <main className="dash"><p className="muted">Loading the dashboard…</p></main>;
  const k = data.kpis;
  const heatmap = data.heatmap ?? [];
  const forecast = data.forecast ?? [];
  const recs = data.recommendations ?? [];
  const weeks = k?.from_date && k?.to_date ? Math.round((Date.parse(k.to_date) - Date.parse(k.from_date)) / 864e5 / 7) : null;
  const updated = new Date(data.generated_at).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return (
    <main className="dash">
      <header className="topbar">
        <span className="brand">QueueSense</span>
        <nav className="topnav" aria-label="Other views">
          <Link to="/">Live queue</Link>
          <Link to="/sim">NFC simulator</Link>
        </nav>
      </header>
      <h1 className="pagetitle">Bus deployment</h1>

      <LiveNow />

      <p className="simnote">
        <strong>Analytics below: Stop A, APU → LRT direction only (for now).</strong>{' '}
        <strong>Simulated history{weeks ? ` (${weeks} weeks)` : ''}.</strong>{' '}
        {k?.journeys
          ? `${k.journeys.toLocaleString()} journeys and ${(k.trips ?? 0).toLocaleString()} bus trips, ${fmtDate(k.from_date)} – ${fmtDate(k.to_date)}, generated to show how the system works.`
          : 'No history loaded yet.'}{' '}
        Analytics computed in BigQuery,{' '}
        {data.source === 'snapshot' ? 'exported as a snapshot on' : 'queried live; results as of'} <strong>{updated}</strong>.
        Real taps already drive the live queue count; loading them into this history is the next step.
      </p>
      {data.forecast_stale && (
        <p className="simnote">
          <strong>Forecast out of date.</strong> The stored forecast has no days left from today. Showing the last forecast
          week; re-run <code>sql/02_forecast.sql</code> in BigQuery to refresh it.
        </p>
      )}

      {/* The answer first (numbers, recommendation, briefing), then the evidence behind it */}
      {k ? (
        <Kpis k={k} range={k.from_date && k.to_date ? `${fmtDate(k.from_date)} to ${fmtDate(k.to_date)}` : null} />
      ) : (
        <Empty title="No key numbers yet">They appear once there is wait history to measure.</Empty>
      )}
      <Recommendations recs={recs} hasForecast={forecast.some((f) => f.scheduled_buses > 0)} />
      <Insights />
      {heatmap.length ? (
        <Heatmap cells={heatmap} />
      ) : (
        <Empty title="Average wait by day and hour">No wait history yet, so there is nothing to map.</Empty>
      )}
      {forecast.some((f) => f.scheduled_buses > 0) ? (
        <ForecastAndWhatIf forecast={forecast} recs={recs} />
      ) : (
        <Empty title="Forecast demand and bus capacity">
          No forecast for the coming days. Run <code>sql/02_forecast.sql</code> in BigQuery to create one.
        </Empty>
      )}

      <p className="foot-note">
        Data from BigQuery ({data.source === 'snapshot' ? 'saved snapshot' : 'live query'}). Forecast by BigQuery ML
        ARIMA_PLUS. Updated {updated}, Malaysia time.
      </p>
    </main>
  );
}

// ---------- Right now: the same live doc the student view reads (aggregates only) ----------
function LiveNow() {
  const [stopId, setStopId] = useState('stopA');
  const stop = stopInfo(stopId);
  const { loading, data, error } = useStop(stopId);
  const dep = data?.last_departure;
  const tiles = [
    { label: 'In the queue now', value: data?.queue_length ?? 0, unit: 'people' },
    { label: 'Last bus', value: dep ? formatMYT(dep.at) : '–', unit: dep?.bus_id ?? '' },
    { label: 'Got on last bus', value: dep?.boarded_count ?? '–', unit: dep ? 'people' : '' },
    { label: 'Left behind by last bus', value: dep?.left_behind_count ?? '–', unit: dep ? 'people' : '' },
  ];
  return (
    <section className="today" aria-label={`Right now at ${stop.name}`}>
      <div className="today-head">
        <h2>Right now at {stop.name}</h2>
        <StopSwitch value={stopId} onPick={setStopId} />
      </div>
      {error ? (
        <p className="warn">Live count unavailable right now, retrying…</p>
      ) : loading ? (
        <p className="muted">Connecting to the live queue…</p>
      ) : (
        <>
          <dl className="today-stats">
            {tiles.map((t) => (
              <div key={t.label}>
                <dt>{t.label}</dt>
                <dd>
                  {t.value}
                  {t.unit && <small>{t.unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted small">
            From today's sticker taps, updates live.{' '}
            {!data ? 'No taps at this stop yet today.' : !dep ? 'No bus has departed yet today.' : ''}
            {data?.simulated ? ' Simulation mode.' : ''}
          </p>
        </>
      )}
    </section>
  );
}

// ---------- KPI tiles ----------
function Kpis({ k, range }) {
  const tiles = [
    { label: 'Average wait', value: `${k.avg_wait_min}`, unit: 'min' },
    { label: '90th percentile wait', value: `${k.p90_wait_min}`, unit: 'min', note: '1 in 10 waits longer' },
    { label: 'Left behind per bus', value: `${k.avg_left_behind_per_bus}`, unit: 'people', bad: true },
    { label: 'Average bus fill', value: `${k.avg_fill_pct}`, unit: '%' },
  ];
  return (
    <section className="block" aria-labelledby="kpi-h">
      <h2 id="kpi-h">Waiting at Stop A</h2>
      {range && <p className="sub">Simulated history, {range}.</p>}
      <div className="kpis">
        {tiles.map((t) => (
          <div key={t.label} className={t.bad ? 'kpi bad' : 'kpi'}>
            <span className="lbl">{t.label}</span>
            <span className="val">
              {t.value}
              <small>{t.unit}</small>
            </span>
            {t.note && <span className="note">{t.note}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- AI summary (Gemini, server-side) ----------
// Loads on its own so a slow Gemini call never holds up the rest of the dashboard.
function Insights() {
  const [ai, setAi] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/insights')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      // Only show an answer in the shape this page knows (an old cached copy has a different one).
      .then((d) => (typeof d?.summary === 'string' && Array.isArray(d.actions) ? d : Promise.reject(new Error('unexpected shape'))))
      .then(setAi, () => setFailed(true));
  }, []);

  if (failed) return null;
  return (
    <section className="panel" aria-labelledby="ai-h" aria-busy={!ai}>
      <div className="ai-head">
        <h2 id="ai-h">AI briefing for management</h2>
        <span className="badge">Simulated data</span>
        {ai && (
          <span className={`badge ${ai.source === 'gemini' ? 'src-ai' : 'src-tpl'}`}>
            {ai.source === 'gemini' ? 'Written by Gemini' : 'Template fallback'}
          </span>
        )}
      </div>
      {!ai ? (
        <p className="muted">Loading the summary…</p>
      ) : (
        <>
          <p className="ai-headline">{ai.summary}</p>
          <h3 className="ai-sub">Top 3 actions</h3>
          <ol className="ai-points ai-actions">
            {ai.actions.map((a) => (
              <li key={a.action}>
                <strong>{a.action}</strong> <span className="muted">{a.reason}</span>
              </li>
            ))}
          </ol>
          <p className="ai-caveat small">
            <strong>Caveat:</strong> {ai.caveat}
          </p>
          {ai.unchecked_numbers?.length > 0 && (
            <p className="warn small">
              Check before acting: {ai.unchecked_numbers.join(', ')} {ai.unchecked_numbers.length > 1 ? 'are' : 'is'} not in the data
              Gemini was given.
            </p>
          )}
          <p className="muted small">
            {ai.source === 'gemini'
              ? `Written by Gemini (${ai.model}, ${ai.provider === 'vertex' ? 'Vertex AI' : 'Gemini API'}) from the aggregate numbers on this page. ${
                  ai.unchecked_numbers?.length ? '' : 'Every number checked against the data. '
                }The recommendation itself comes from the forecast replay, not the AI.`
              : `${ai.reason}, so this is a fixed summary built from the same numbers.`}
          </p>
        </>
      )}
    </section>
  );
}

function Empty({ title, children }) {
  return (
    <section className="panel" role="status">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </section>
  );
}

// ---------- Recommendations ----------
function Recommendations({ recs, hasForecast }) {
  if (!recs.length) {
    return hasForecast ? (
      <Empty title="Recommended change, next 7 days">
        No extra buses needed: the timetable carries the forecast demand without long waits.
      </Empty>
    ) : null;
  }
  const [top, ...rest] = recs;
  return (
    <section className="decision" aria-labelledby="rec-h">
      <h2 id="rec-h">Recommended change, next 7 days</h2>
      <div className="rec">
        <p className="rec-main">
          Add <strong>{top.add_buses} bus{top.add_buses > 1 ? 'es' : ''}</strong> at{' '}
          <strong>
            {fmtDate(top.slot_date)}, {fmtH(top.hour)}
          </strong>{' '}
          ({top.scheduled_buses} → {top.scheduled_buses + top.add_buses} buses that hour).
        </p>
        <div className="rec-nums">
          <Delta label={`Wait at ${fmtH(top.impact_hour)}`} before={top.wait_before_min} after={top.wait_after_min} unit="min" />
          <Delta label="Left behind per bus" before={top.left_behind_before} after={top.left_behind_after} unit="" />
          <div className="delta">
            <span className="lbl">Waiting saved that day</span>
            <span className="val">
              <strong>{top.person_hours_saved}</strong>
              <small>person-hours</small>
            </span>
          </div>
        </div>
        <p className="muted">
          Forecast {top.forecast_joins} people at {fmtH(top.hour)}. Numbers come from replaying the forecast through the timetable,
          not from the AI.
        </p>
        <h3 className="assume-h">Assumptions</h3>
        <ul className="assume">
          <li>{CAPACITY} seats per bus</li>
          <li>Extra buses evenly spaced within the hour</li>
          <li>People give up after {ABANDON_MIN} min</li>
          <li>
            Cost per extra trip: not modelled. Changes are ranked by waiting saved (
            {Math.round(top.person_hours_saved / top.add_buses)} person-hours per extra bus here)
          </li>
        </ul>
      </div>
      {rest.length > 0 && (
        <details className="more">
          <summary>
            {rest.length} more change{rest.length > 1 ? 's' : ''} in the next 7 days
          </summary>
          <ul className="reclist">
            {rest.map((r) => (
              <li key={r.slot_date + r.hour}>
                <span>
                  {fmtDate(r.slot_date)} {fmtH(r.hour)}: +{r.add_buses}
                </span>
                <span>
                  wait at {fmtH(r.impact_hour)} {r.wait_before_min} → {r.wait_after_min} min
                </span>
                <span className="muted">{r.person_hours_saved} person-hours</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Delta({ label, before, after, unit }) {
  return (
    <div className="delta">
      <span className="lbl">{label}</span>
      <span className="val">
        {before} → <strong>{after}</strong>
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

// ---------- Heatmap ----------
function Heatmap({ cells }) {
  const [tip, setTip] = useState(null);
  const at = useMemo(() => new Map(cells.map((c) => [`${c.dow_idx}-${c.hour}`, c])), [cells]);
  return (
    <section className="panel" aria-labelledby="hm-h">
      <h2 id="hm-h">Average wait by day and hour</h2>
      <p className="sub">Minutes, Malaysia time. Darker blue means a longer wait. No service on Sundays.</p>
      <div className="hm-scroll">
        <div className="hm" role="grid" aria-label="Average wait in minutes" onMouseLeave={() => setTip(null)}>
          <span />
          {HOURS.map((h) => (
            <span key={h} className="hm-col">
              {fmtH(h)}
            </span>
          ))}
          {DAYS.map((d, di) => (
            <Row key={d} d={d}>
              {HOURS.map((h) => {
                const c = at.get(`${di}-${h}`);
                if (!c) return <span key={h} className="hm-cell empty" aria-label={`${d} ${fmtH(h)}: no service`} />;
                const b = binOf(c.avg_wait_min);
                return (
                  <button
                    key={h}
                    className={`hm-cell s${b.step}`}
                    aria-label={`${d} ${fmtH(h)}: average wait ${c.avg_wait_min} minutes`}
                    onMouseEnter={(e) => setTip({ c, x: e.currentTarget.offsetLeft, y: e.currentTarget.offsetTop })}
                    onFocus={(e) => setTip({ c, x: e.currentTarget.offsetLeft, y: e.currentTarget.offsetTop })}
                    onBlur={() => setTip(null)}
                  >
                    {Math.round(c.avg_wait_min)}
                  </button>
                );
              })}
            </Row>
          ))}
          {tip && (
            <div className="tooltip" style={{ left: tip.x, top: tip.y - 8 }} role="status">
              <strong>
                {tip.c.dow} {fmtH(tip.c.hour)}
              </strong>
              <span>Average wait {tip.c.avg_wait_min} min</span>
              <span>1 in 10 waits {tip.c.p90_wait_min}+ min</span>
              <span className="muted">{tip.c.journeys.toLocaleString()} journeys</span>
            </div>
          )}
        </div>
      </div>
      <div className="hm-legend" aria-hidden>
        <span className="muted small">Minutes</span>
        {BINS.map((b) => (
          <span key={b.label} className="hm-key">
            <i className={`s${b.step}`} /> {b.label}
          </span>
        ))}
      </div>
      <details className="more">
        <summary>Show as table</summary>
        <table className="datatable">
          <thead>
            <tr>
              <th>Day</th>
              {HOURS.map((h) => (
                <th key={h}>{fmtH(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((d, di) => (
              <tr key={d}>
                <th>{d}</th>
                {HOURS.map((h) => (
                  <td key={h}>{at.get(`${di}-${h}`)?.avg_wait_min ?? '–'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

const Row = ({ d, children }) => (
  <>
    <span className="hm-row">{d}</span>
    {children}
  </>
);

// ---------- Forecast + what-if ----------
function ForecastAndWhatIf({ forecast, recs }) {
  const dates = [...new Set(forecast.filter((f) => f.scheduled_buses > 0).map((f) => f.date))];
  const [date, setDate] = useState(recs[0]?.slot_date ?? dates[0]);
  const daySlots = forecast.filter((f) => f.date === date && f.scheduled_buses > 0);
  const [hour, setHour] = useState(recs[0]?.hour ?? 7);
  const [extra, setExtra] = useState(0);

  const base = useMemo(() => simulateDay(daySlots), [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const after = useMemo(() => simulateDay(daySlots, { [hour]: extra }), [date, hour, extra]); // eslint-disable-line react-hooks/exhaustive-deps
  const worst = (rows) => rows.reduce((m, r) => (r.avg_wait_min > m.avg_wait_min ? r : m), rows[0] ?? { avg_wait_min: 0 });
  const people = base.reduce((s, r) => s + r.joins, 0);
  const avg = (rows) => rows.reduce((s, r) => s + r.avg_wait_min * r.joins, 0) / (people || 1);
  const saved = Math.round(((avg(base) - avg(after)) * people) / 60);

  function pickDate(d) {
    setDate(d);
    setExtra(0);
    // Keep the chosen hour if that day has it; otherwise use that day's first recommended hour.
    const hours = forecast.filter((f) => f.date === d && f.scheduled_buses > 0).map((f) => f.hour);
    if (!hours.includes(hour)) setHour(recs.find((r) => r.slot_date === d)?.hour ?? hours[0]);
  }

  return (
    <>
      <section className="panel" aria-labelledby="fc-h">
        <h2 id="fc-h">Forecast demand and bus capacity, next 7 days</h2>
        <p className="sub">People expected per hour against seats per hour. Coral bars have more people than seats.</p>
        <div className="chips" role="group" aria-label="Day">
          {dates.map((d) => (
            <button key={d} className={d === date ? 'chip on' : 'chip'} aria-pressed={d === date} onClick={() => pickDate(d)}>
              {fmtDate(d)}
            </button>
          ))}
        </div>
        <ForecastChart slots={daySlots} extra={{ [hour]: extra }} />
      </section>


      <section className="panel whatif" aria-labelledby="wi-h">
        <h2 id="wi-h">What if we add buses on {fmtDate(date)}?</h2>
        <p className="sub">Changes here redraw the seats line in the chart above. Pick another day there.</p>
        <div className="whatif-controls">
          <label>
            Hour
            <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {daySlots.map((s) => (
                <option key={s.hour} value={s.hour}>
                  {fmtH(s.hour)} ({s.scheduled_buses} buses now)
                </option>
              ))}
            </select>
          </label>
          <label className="slider">
            Extra buses: <strong>{extra}</strong>
            <input type="range" min="0" max="4" step="1" value={extra} onChange={(e) => setExtra(Number(e.target.value))} />
          </label>
        </div>
        <div className="rec-nums">
          <Delta label="Worst hourly wait" before={worst(base).avg_wait_min} after={worst(after).avg_wait_min} unit="min" />
          <Delta
            label="Most left behind per bus"
            before={Math.max(...base.map((r) => r.left_behind_per_bus))}
            after={Math.max(...after.map((r) => r.left_behind_per_bus))}
            unit=""
          />
          <div className="delta">
            <span className="lbl">Waiting saved that day</span>
            <span className="val">
              <strong>{Math.max(0, saved)}</strong>
              <small>person-hours</small>
            </span>
          </div>
        </div>
        <p className="muted small">
          Replays the forecast through the timetable with {CAPACITY}-seat buses. Simulated estimate, not a promise.
        </p>
      </section>
    </>
  );
}

function ForecastChart({ slots, extra }) {
  const [tip, setTip] = useState(null);
  const W = 640;
  const H = 240;
  const pad = { l: 40, r: 12, t: 12, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const cap = (s) => (s.scheduled_buses + (extra[s.hour] ?? 0)) * CAPACITY;
  const max = Math.max(...slots.map((s) => Math.max(s.joins_high, cap(s))), 40);
  const nice = Math.ceil(max / 100) * 100;
  const y = (v) => pad.t + ih - (v / nice) * ih;
  const bw = iw / Math.max(slots.length, 1);
  const ticks = [0, nice / 2, nice];
  const capPath = slots
    .map((s, i) => `${i ? 'L' : 'M'}${pad.l + i * bw},${y(cap(s))} L${pad.l + (i + 1) * bw},${y(cap(s))}`)
    .join(' ');

  return (
    <div className="chartwrap" onMouseLeave={() => setTip(null)}>
      <div className="legend">
        <span>
          <i className="sw fc" /> Forecast people per hour (80% range)
        </span>
        <span>
          <i className="sw cap" /> Seats per hour (buses × {CAPACITY})
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Forecast people per hour against seats per hour">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {slots.map((s, i) => {
          const x = pad.l + i * bw;
          const over = s.forecast_joins > cap(s);
          return (
            <g key={s.hour}>
              <rect
                className="hit"
                x={x}
                y={pad.t}
                width={bw}
                height={ih}
                onMouseEnter={() => setTip({ s, x: x + bw / 2, over })}
              />
              <rect
                className={over ? 'bar over' : 'bar'}
                x={x + bw * 0.2}
                width={bw * 0.6}
                y={y(s.forecast_joins)}
                height={Math.max(0, y(0) - y(s.forecast_joins))}
                rx="3"
              />
              <line className="range" x1={x + bw / 2} x2={x + bw / 2} y1={y(s.joins_low)} y2={y(s.joins_high)} />
              <text className="axis" x={x + bw / 2} y={H - 8} textAnchor="middle">
                {i % 2 === 0 ? fmtH(s.hour) : ''}
              </text>
            </g>
          );
        })}
        <path className="cap" d={capPath} fill="none" />
        <line className="baseline" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: `${(tip.x / W) * 100}%`, top: 24 }} role="status">
          <strong>{fmtH(tip.s.hour)}</strong>
          <span>
            Forecast {tip.s.forecast_joins} people ({tip.s.joins_low}–{tip.s.joins_high})
          </span>
          <span>
            {tip.s.scheduled_buses + (extra[tip.s.hour] ?? 0)} buses = {cap(tip.s)} seats
          </span>
          {tip.over && <span className="warn">More people than seats</span>}
        </div>
      )}
      <details className="more">
        <summary>Show as table</summary>
        <table className="datatable">
          <thead>
            <tr>
              <th>Hour</th>
              <th>Forecast</th>
              <th>Range</th>
              <th>Buses</th>
              <th>Seats</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.hour}>
                <th>{fmtH(s.hour)}</th>
                <td>{s.forecast_joins}</td>
                <td>
                  {s.joins_low}–{s.joins_high}
                </td>
                <td>{s.scheduled_buses + (extra[s.hour] ?? 0)}</td>
                <td>{cap(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
