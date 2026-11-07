import { useParams } from 'react-router-dom';
import { useStop } from '../live.js';
import { formatMYT } from '../tags.js';

// Student-facing live counter for a stop. Aggregates only.
export default function Live() {
  const { stopId = 'stopA' } = useParams();
  const { loading, data } = useStop(stopId);
  const name = `Stop ${stopId.replace(/^stop/, '')}`;
  const n = data?.queue_length ?? 0;

  return (
    <main className="live">
      <header className="livehead">
        <div>
          <p className="eyebrow">QueueSense · APU shuttle</p>
          <h1>{name}</h1>
        </div>
        <span className="pill">
          <span className="dot" aria-hidden /> Live
        </span>
      </header>

      {data?.simulated && <p className="simnote">Simulated data. Real stickers are not connected yet.</p>}

      {loading ? (
        <p className="muted">Connecting…</p>
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

          <p className="hint">Tap your phone on the QueueSense sticker at the stop to join. No app, no login.</p>
          {data?.updated_at && <p className="muted small">Last tap {formatMYT(data.updated_at)} · Malaysia time</p>}
        </>
      )}
    </main>
  );
}
