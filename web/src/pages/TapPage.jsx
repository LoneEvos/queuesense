import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { recordTap, sendTap } from '../outbox.js';
import { currentUid, readStop } from '../firebase.js';
import { formatMYT, placeName, TAGS } from '../tags.js';
import { freshStop, positionFor, useStop, waitFor } from '../live.js';
import { AlertIcon, CheckIcon, ClockIcon } from '../icons.jsx';

// What a sticker tap means:
//   bus sticker    -> board (always; a board with no queue entry is still recorded, flagged)
//   driver sticker -> depart (always)
//   queue sticker  -> join; if this phone is already in that stop's queue: "already in the queue (#N)",
//                     no second entry. Boarding is only ever recorded at a bus sticker, so it has a bus_id.
// The same sticker again within 30 s is a phone re-read and is ignored.
const REPEAT_MS = 30_000;
const JOIN_TTL_MS = 60 * 60 * 1000; // same expiry as the server's live queue

// Per-phone memory, keyed by the anonymous user so "New student" in the simulator starts clean.
const mem = {
  get(k) {
    try {
      return Number(localStorage.getItem(k)) || null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  },
  drop(prefix) {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
    } catch {}
  },
};
const joinKey = (uid, stopId) => `qs-join-${uid}-${stopId}`;
const lastKey = (uid, tagId) => `qs-last-${uid}-${tagId}`;
const tagOf = (tagId) => TAGS.find((t) => t.tag_id === tagId) ?? null;

// One sticker open = one tap. Guard against React StrictMode running the effect twice.
const handled = new Set();

// Inside the NFC simulator: report each result to the sticker panel.
function report(tagId, kind, data, at) {
  if (window.parent === window) return;
  const student = new URLSearchParams(window.location.search).get('student');
  window.parent.postMessage({ type: 'qs-tap', tag_id: tagId, kind, data, student, at }, window.location.origin);
}

export default function TapPage() {
  const { tagId } = useParams();
  const tag = tagOf(tagId);
  const [state, setState] = useState({ kind: 'sending' });
  const uidRef = useRef('anon');
  const started = useRef(false);

  async function send() {
    const uid = uidRef.current;
    setState({ kind: 'sending' });
    const tap = await recordTap(tagId);
    mem.set(lastKey(uid, tagId), Date.now());
    const result = await sendTap(tap);
    const d = result.data ?? {};
    if (result.kind === 'accepted' && d.event_type === 'QUEUE_JOIN') mem.set(joinKey(uid, d.stop_id), Date.parse(d.timestamp));
    if (result.kind === 'accepted' && d.event_type === 'BUS_BOARD') mem.drop(`qs-join-${uid}-`);
    navigator.vibrate?.(result.kind === 'accepted' ? 60 : [40, 60, 40]);
    report(tagId, result.kind, d, tap.timestamp);
    // The server says this phone is already queueing (its storage may have been cleared).
    if (result.kind === 'accepted' && d.status === 'already_in_queue') {
      mem.set(joinKey(uid, d.stop_id), Date.parse(d.timestamp));
      return setState({ kind: 'already', stopId: d.stop_id, joinMs: Date.parse(d.timestamp), position: d.position });
    }
    setState({ ...result, tap });
  }

  useEffect(() => {
    if (started.current || handled.has(tagId)) return;
    started.current = true;
    handled.add(tagId);
    (async () => {
      const uid = (await currentUid()) ?? 'anon';
      uidRef.current = uid;
      const now = Date.now();
      const stopId = tag?.stop_id || null;
      const joined = stopId ? mem.get(joinKey(uid, stopId)) : null;
      const activeJoin = joined && now - joined < JOIN_TTL_MS ? joined : null;

      // 1. Same sticker again within 30 s: a re-read, not a new tap. Record nothing.
      const last = mem.get(lastKey(uid, tagId));
      if (last && now - last < REPEAT_MS) {
        report(tagId, 'repeat', { code: 'REPEAT_IGNORED' }, new Date(now).toISOString());
        return setState({ kind: 'repeat', stopId, joinMs: activeJoin });
      }

      // 2. Queue sticker while this phone is in that stop's queue: show its place, send nothing.
      if (tag?.tag_type === 'QUEUE' && activeJoin) {
        const live = await readStop(stopId); // undefined = could not check (offline): trust the phone
        const stillIn = live === undefined || positionFor(freshStop(live), activeJoin) !== null;
        if (stillIn) {
          report(tagId, 'already', { code: 'ALREADY_IN_QUEUE' }, new Date(now).toISOString());
          return setState({ kind: 'already', stopId, joinMs: activeJoin });
        }
        mem.drop(joinKey(uid, stopId)); // boarded or expired since: this tap is a fresh join
      }

      // 3. Otherwise the sticker means what it says.
      await send();
    })();
  }, [tagId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopId = state.data?.stop_id || state.stopId || tag?.stop_id || 'stopA';
  return (
    <main className="tap">
      <Card state={state} tagId={tagId} />
      <nav className="foot">
        <Link to={`/live/${stopId}`}>Live queue</Link>
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

  if (state.kind === 'already') {
    return <AlreadyInQueue stopId={state.stopId} joinMs={state.joinMs} position={state.position} />;
  }

  if (state.kind === 'repeat') {
    return (
      <section className="card ok" role="status">
        <div className="icon">
        <CheckIcon />
      </div>
        <h1>Already recorded</h1>
        <p className="muted">You tapped this sticker a few seconds ago, so this tap was not counted again.</p>
        {state.joinMs && state.stopId && <QueueStatus stopId={state.stopId} joinMs={state.joinMs} />}
      </section>
    );
  }

  const d = state.data || {};

  if (state.kind === 'queued') {
    return (
      <section className="card pending" role="status">
        <div className="icon">
          <ClockIcon />
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
    const stopId = tagOf(tagId)?.stop_id;
    return (
      <section className={`card ${soft ? 'ok' : 'bad'}`} role="alert">
        <div className="icon">{soft ? <CheckIcon /> : <AlertIcon />}</div>
        <h1>{soft ? 'You are already in the queue' : "Couldn't record that tap"}</h1>
        {soft && stopId ? <QueueStatus stopId={stopId} /> : <p>{friendly[d.code] ?? d.message ?? 'Please try again.'}</p>}
      </section>
    );
  }

  // accepted
  if (d.status === 'repeat_ignored') {
    return (
      <section className="card ok" role="status">
        <div className="icon">
        <CheckIcon />
      </div>
        <h1>Already recorded</h1>
        <p className="muted">This tap was a repeat within 30 seconds, so it was not counted again.</p>
      </section>
    );
  }

  const already = d.status === 'already_in_queue';
  const title = {
    QUEUE_JOIN: already ? "You're still in the queue" : "You're in the queue",
    BUS_BOARD: "You're on board",
    BUS_DEPART: 'Departure recorded',
  }[d.event_type];

  return (
    <section className="card ok" role="status">
      {d.simulated && <span className="badge">Simulation</span>}
      <div className="icon">
        <CheckIcon />
      </div>
      <h1>{title ?? 'Tap recorded'}</h1>
      <p className="muted">
        {placeName(d)}, {already ? 'joined at' : 'at'} {formatMYT(d.timestamp)}
      </p>

      {d.event_type === 'QUEUE_JOIN' && <QueueStatus stopId={d.stop_id} joinMs={Date.parse(d.timestamp)} fallback={d} />}

      {d.event_type === 'BUS_BOARD' && (
        <>
          {d.wait_s != null && (
            <p className="big">You waited {d.wait_s < 60 ? 'under a minute' : `${Math.round(d.wait_s / 60)} min`}</p>
          )}
          {d.flagged ? (
            <p className="warn">Boarding recorded. Next time, tap the queue sticker when you join so your wait counts.</p>
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

// Already queueing at this stop: no second entry. Boarding is recorded when they tap the bus sticker.
function AlreadyInQueue({ stopId, joinMs, position: fromServer }) {
  const { data } = useStop(stopId);
  const position = positionFor(data, joinMs) ?? fromServer ?? null;
  return (
    <section className="card ok" role="status">
      <div className="icon">
        <CheckIcon />
      </div>
      <h1>{position ? `You are already in the queue (#${position})` : 'You are already in the queue'}</h1>
      <p className="muted">Your place is kept. Tap the sticker inside the bus door when you get on.</p>
      <QueueStatus stopId={stopId} joinMs={joinMs} fallback={{ position: fromServer }} />
    </section>
  );
}

// Live place in the queue. Moves up as people ahead board, no refresh needed.
function QueueStatus({ stopId, joinMs, fallback }) {
  const { loading, data, error } = useStop(stopId);
  const live = positionFor(data, joinMs);

  if (!loading && data && joinMs && !live) {
    return <p className="big">You've left the queue. Safe trip.</p>;
  }
  const position = live ?? fallback?.position ?? null;
  const wait = live ? waitFor(data, live) : (fallback?.est_wait_min ?? null);
  if (!position) return <p>{error ? "You're in the queue. Live position will show when the connection is back." : "You're in the queue."}</p>;

  return (
    <div className="place" aria-live="polite">
      <span className="lbl">Your place</span>
      <span className="num">#{position}</span>
      <span className="big">{wait ? `about ${wait} min` : 'Wait time shows after the first few boardings'}</span>
      {data && (
        <span className="muted">
          <span className="dot" aria-hidden /> {data.queue_length} in the queue, updates live
        </span>
      )}
    </div>
  );
}
