import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CAPACITY, simulateDay } from '../../../insights/recommend.js';

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

  useEffect(() => {
    fetch('/api/dispatch')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData, (e) => setError(String(e.message || e)));
  }, []);

  if (error) return <main className="dash"><p className="warn">Could not load the dashboard: {error}</p></main>;
  if (!data) return <main className="dash"><p className="muted">Loading the dashboard…</p></main>;

  return (
    <main className="dash viz">
      <header className="dashhead">
        <div>
          <p className="eyebrow">QueueSense · Dispatcher</p>
          <h1>Stop A: bus deployment</h1>
        </div>
        <nav className="dashnav">
          <Link to="/">Live queue</Link>
          <Link to="/sim">NFC simulator</Link>
        </nav>
      </header>

      <p className="simnote">
        <strong>Simulated history.</strong> {data.kpis.journeys.toLocaleString()} journeys and {data.kpis.trips.toLocaleString()} bus
        trips, {fmtDate(data.kpis.from_date)} – {fmtDate(data.kpis.to_date)}, generated to show how the system works. Live taps
        will replace it once the stickers are in use.
      </p>

      <Kpis k={data.kpis} />
      <Recommendations recs={data.recommendations} />
      <Heatmap cells={data.heatmap} />
      <ForecastAndWhatIf forecast={data.forecast} recs={data.recommendations} />

      <p className="muted small">
        Data: BigQuery ({data.source === 'snapshot' ? 'saved snapshot' : 'live query'}) · forecast: BigQuery ML ARIMA_PLUS ·
        updated {new Date(data.generated_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} Malaysia time
      </p>
    </main>
  );
}

// ---------- KPI tiles ----------
function Kpis({ k }) {
  const tiles = [
    { label: 'Average wait', value: `${k.avg_wait_min}`, unit: 'min' },
    { label: '90th percentile wait', value: `${k.p90_wait_min}`, unit: 'min', note: '1 in 10 waits longer' },
    { label: 'Left behind per bus', value: `${k.avg_left_behind_per_bus}`, unit: 'people' },
    { label: 'Average bus fill', value: `${k.avg_fill_pct}`, unit: '%' },
  ];
  return (
    <section className="kpis" aria-label="Key numbers, all of history">
      {tiles.map((t) => (
        <div key={t.label} className="kpi">
          <span className="lbl">{t.label}</span>
          <span className="val">
            {t.value}
            <small>{t.unit}</small>
          </span>
          {t.note && <span className="muted small">{t.note}</span>}
        </div>
      ))}
    </section>
  );
}

// ---------- Recommendations ----------
function Recommendations({ recs }) {
  if (!recs.length) return null;
  const [top, ...rest] = recs;
  return (
    <section className="panel" aria-labelledby="rec-h">
      <h2 id="rec-h">Recommendation for this week</h2>
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
            <span className="val">{top.person_hours_saved} person-hours</span>
          </div>
        </div>
        <p className="muted small">
          Forecast {top.forecast_joins} people at {fmtH(top.hour)}. Numbers come from replaying the forecast through the timetable,
          not from the AI.
        </p>
      </div>
      {rest.length > 0 && (
        <details className="more">
          <summary>{rest.length} more changes this week</summary>
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
        {before} → <strong>{after}</strong> {unit}
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
      <p className="muted small">Malaysia time. No service on Sundays.</p>
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
    <section className="panel" aria-labelledby="fc-h">
      <h2 id="fc-h">Forecast demand and bus capacity</h2>
      <div className="chips" role="group" aria-label="Day">
        {dates.map((d) => (
          <button key={d} className={d === date ? 'chip on' : 'chip'} aria-pressed={d === date} onClick={() => pickDate(d)}>
            {fmtDate(d)}
          </button>
        ))}
      </div>

      <ForecastChart slots={daySlots} extra={{ [hour]: extra }} />

      <div className="whatif">
        <h3>What if we add buses?</h3>
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
            <span className="val">{Math.max(0, saved)} person-hours</span>
          </div>
        </div>
        <p className="muted small">
          Replays the forecast through the timetable with {CAPACITY}-seat buses. Simulated estimate, not a promise.
        </p>
      </div>
    </section>
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
