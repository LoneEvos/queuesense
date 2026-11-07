import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { recordTap, sendTap } from '../outbox.js';
import { formatMYT, placeName, TAGS } from '../tags.js';
import { positionFor, useStop, waitFor } from '../live.js';

const joinKey = (stopId) => `qs-join-${stopId}`;
function saveJoin(stopId, ms) {
  try {
    localStorage.setItem(joinKey(stopId), String(ms));
  } catch {}
}
function loadJoin(stopId) {
  try {
    return Number(localStorage.getItem(joinKey(stopId))) || null;
  } catch {
    return null;
  }
}
const stopOf = (tagId) => TAGS.find((t) => t.tag_id === tagId)?.stop_id || null;

// One sticker open = one tap. Guard against React StrictMode running the effect twice.
const handled = new Set();

export default function TapPage() {
  const { tagId } = useParams();
  const [state, setState] = useState({ kind: 'sending' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current || handled.has(tagId)) return;
    started.current = true;
    handled.add(tagId);
    (async () => {
      const tap = await recordTap(tagId);
      const result = await sendTap(tap);
      if (result.kind === 'accepted' && result.data.event_type === 'QUEUE_JOIN') {
        saveJoin(result.data.stop_id, Date.parse(result.data.timestamp));
      }
      setState({ ...result, tap });
      navigator.vibrate?.(result.kind === 'accepted' ? 60 : [40, 60, 40]);
      // Inside the NFC simulator: report the result to the sticker panel.
      if (window.parent !== window) {
        const student = new URLSearchParams(window.location.search).get('student');
        window.parent.postMessage(
          { type: 'qs-tap', tag_id: tagId, kind: result.kind, data: result.data, student, at: tap.timestamp },
          window.location.origin,
        );
      }
    })();
  }, [tagId]);

  const stopId = state.data?.stop_id || stopOf(tagId) || 'stopA';
  return (
    <main className="tap">
      <Card state={state} tagId={tagId} />
      <nav className="foot">
        <Link to={`/live/${stopId}`}>Live queue</Link>
        <span aria-hidden>·</span>
        <span>No name or student ID collected</span>
      </nav>
    </main>
  );
}

function Card({ state, tagId }) {
  if (state.kind === 'sending') {
    return (
      <section className="card">
        <div className="spinner" aria-hidden />
        <h1>Recording your tap…</h1>
      </section>
    );
  }

  const d = state.data || {};

  if (state.kind === 'queued') {
    return (
      <section className="card pending" role="status">
        <div className="icon" aria-hidden>
          ⏳
        </div>
        <h1>Tap saved</h1>
        <p>
          {d.reason === 'server'
            ? "The queue server isn't ready right now. Your tap is saved on this phone and sends by itself."
            : "No connection right now. It sends by itself when you're back online."}
        </p>
        <p className="muted">Tapped at {formatMYT(state.tap.timestamp)}</p>
      </section>
    );
  }

  if (state.kind === 'rejected') {
    const soft = d.code === 'ALREADY_IN_QUEUE';
    const friendly = {
      ALREADY_IN_QUEUE: "You're already in the queue. No need to tap again.",
      UNKNOWN_TAG: "This sticker isn't registered. Please tell the bus staff.",
      INACTIVE_TAG: 'This sticker is switched off right now.',
      RATE_LIMITED: 'Too many taps. Wait a minute, then try again.',
    };
    const stopId = stopOf(tagId);
    return (
      <section className={`card ${soft ? 'ok' : 'bad'}`} role="alert">
        <div className="icon" aria-hidden>
          {soft ? '✓' : '!'}
        </div>
        <h1>{soft ? "You're still in the queue" : "Couldn't record that tap"}</h1>
        {soft && stopId ? (
          <QueueStatus stopId={stopId} joinMs={loadJoin(stopId)} />
        ) : (
          <p>{friendly[d.code] ?? d.message ?? 'Please try again.'}</p>
        )}
      </section>
    );
  }

  // accepted
  const already = d.status === 'already_in_queue';
  const title = {
    QUEUE_JOIN: already ? "You're still in the queue" : "You're in the queue",
    BUS_BOARD: "You're on board",
    BUS_DEPART: 'Departure recorded',
  }[d.event_type];

  return (
    <section className="card ok" role="status">
      {d.simulated && <span className="badge">SIMULATION</span>}
      <div className="icon" aria-hidden>
        ✓
      </div>
      <h1>{title ?? 'Tap recorded'}</h1>
      <p className="muted">
        {placeName(d)} · {already ? 'joined' : ''} {formatMYT(d.timestamp)}
      </p>

      {d.event_type === 'QUEUE_JOIN' && <QueueStatus stopId={d.stop_id} joinMs={Date.parse(d.timestamp)} fallback={d} />}

      {d.event_type === 'BUS_BOARD' && (
        <>
          {d.wait_s != null && (
            <p className="big">
              You waited {d.wait_s < 60 ? 'under a minute' : `${Math.round(d.wait_s / 60)} min`}
            </p>
          )}
          {d.flagged ? (
            <p className="warn">Next time, tap the queue sticker when you join so your wait counts.</p>
          ) : (
            <p>Have a good trip.</p>
          )}
        </>
      )}

      {d.event_type === 'BUS_DEPART' && (
        <div className="trip">
          <div>
            <span className="num">{d.boarded_count}</span>
            <span className="muted">boarded</span>
          </div>
          <div>
            <span className="num">{d.left_behind_count ?? '–'}</span>
            <span className="muted">left behind</span>
          </div>
        </div>
      )}
    </section>
  );
}

// Live place in the queue. Moves up as people ahead board, no refresh needed.
function QueueStatus({ stopId, joinMs, fallback }) {
  const { loading, data } = useStop(stopId);
  const live = positionFor(data, joinMs);

  if (!loading && data && !live) {
    return <p className="big">You've left the queue. Safe trip.</p>;
  }
  const position = live ?? fallback?.position ?? null;
  const wait = live ? waitFor(data, live) : (fallback?.est_wait_min ?? null);
  if (!position) return <p>You're in the queue.</p>;

  return (
    <div className="place" aria-live="polite">
      <span className="lbl">Your place</span>
      <span className="num">#{position}</span>
      <span className="big">{wait ? `about ${wait} min` : 'Wait time shows after the first few boardings'}</span>
      {data && (
        <span className="muted">
          <span className="dot" aria-hidden /> {data.queue_length} in the queue · updates live
        </span>
      )}
    </div>
  );
}
