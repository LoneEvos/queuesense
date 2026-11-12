import { Link, useParams } from 'react-router-dom';
import { useStop } from '../live.js';
import { formatMYT, stopInfo } from '../tags.js';
import StopSwitch from '../StopSwitch.jsx';

// Student-facing live counter for a stop. Aggregates only.
export default function Live() {
  const { stopId = 'stopA' } = useParams();
  const { loading, data, error } = useStop(stopId);
  const stop = stopInfo(stopId);
  const n = data?.queue_length ?? 0;

  return (
    <main className="live">
      <header className="topbar">
        <span className="brand">QueueSense</span>
        <span className="pill">
          <span className="dot" aria-hidden /> Live
        </span>
      </header>
      <div className="livehead">
        <div>
          <h1>{stop.name}</h1>
          {stop.route && <p className="route-sub">APU shuttle, {stop.route}</p>}
        </div>
      </div>

      <StopSwitch value={stopId} linkFor={(id) => `/live/${id}`} />

      {data?.simulated && <p className="simnote">Simulation mode: every tap at this stop is recorded as test data.</p>}

      {loading ? (
        <p className="muted">Connecting…</p>
      ) : error ? (
        <section className="errstate" role="alert">
          <h2>Can't reach the live count right now</h2>
          <p>This page keeps trying by itself. Taps at the stop are still saved on each phone and sent when the server is back.</p>
        </section>
      ) : (
        <>
          <section className="counter" aria-live="polite">
            <span className="num">{n}</span>
            <span className="lbl">{n === 1 ? 'person' : 'people'} in the queue now</span>
          </section>

          <section className="wait">
            <span className="lbl">If you join now</span>
            <span className="val">{data?.est_wait_min ? `about ${data.est_wait_min} min` : n ? 'Estimating…' : 'No wait'}</span>
          </section>

          <dl className="stats">
            <div>
              <dt>Last bus</dt>
              <dd>{data?.last_departure ? formatMYT(data.last_departure.at) : '–'}</dd>
            </div>
            <div>
              <dt>Got on</dt>
              <dd>{data?.last_departure?.boarded_count ?? '–'}</dd>
            </div>
            <div>
              <dt>Left behind</dt>
              <dd>{data?.last_departure?.left_behind_count ?? '–'}</dd>
            </div>
          </dl>

          {!data && <p className="muted">No taps at this stop yet today. The count starts with the first tap.</p>}
          <p className="hint">Tap your phone on the QueueSense sticker at the stop to join. No app, no login.</p>
          {data?.updated_at && <p className="muted small">Last tap at {formatMYT(data.updated_at)}, Malaysia time.</p>}
        </>
      )}
      <nav className="foot" aria-label="Other views">
        <Link to="/dispatch">Dispatcher dashboard</Link>
        <Link to="/sim">NFC simulator</Link>
      </nav>
    </main>
  );
}
