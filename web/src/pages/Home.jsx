import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { becomeNewStudent } from '../firebase.js';
import { decodeUriSticker, encodeUriSticker, NTAG213_USER_BYTES, toHex } from '../ndef.js';
import { formatMYT, TAG_LABEL, TAGS } from '../tags.js';
import { useStop } from '../live.js';

// NFC simulator. Each virtual sticker holds the NDEF bytes a real NTAG213 will hold.
// "Tapping" decodes those bytes like a phone does and opens the URL in the virtual phone.
// When real stickers arrive, write the same URL (with the deployed domain) using NFC Tools.
export default function Home() {
  const origin = window.location.origin;
  const stickers = useMemo(
    () =>
      TAGS.map((t) => {
        const url = `${origin}/t/${t.tag_id}`;
        return { ...t, url, bytes: encodeUriSticker(url) };
      }),
    [origin],
  );

  const [phoneUrl, setPhoneUrl] = useState(null);
  const [tapKey, setTapKey] = useState(0);
  const [reading, setReading] = useState(null);
  const [student, setStudent] = useState(1);
  const [log, setLog] = useState([]);
  const { data: stopA, error: stopError } = useStop('stopA');
  const [simError, setSimError] = useState(null);
  const phoneRef = useRef(null);

  // The tap page inside the phone reports each result back here.
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== origin || e.data?.type !== 'qs-tap') return;
      setLog((l) => [{ ...e.data, student: e.data.student }, ...l].slice(0, 12));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin]);

  function tap(sticker) {
    setReading(sticker.tag_id);
    navigator.vibrate?.(40);
    // A phone needs ~200-400 ms to read and open the link.
    setTimeout(() => {
      const url = decodeUriSticker(sticker.bytes);
      setPhoneUrl(`${new URL(url).pathname}?student=${student}`);
      setTapKey((k) => k + 1);
      setReading(null);
      // On narrow screens the phone sits below the stickers: bring it into view.
      if (window.matchMedia('(max-width: 760px)').matches) {
        phoneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 300);
  }

  async function newStudent() {
    try {
      await becomeNewStudent();
      setSimError(null);
      setStudent((s) => s + 1);
      setPhoneUrl(null);
    } catch {
      setSimError("Couldn't switch to a new student (sign-in failed). Check the connection and try again.");
    }
  }

  return (
    <main className="sim">
      <header className="simhead">
        <h1>NFC simulator</h1>
        <span className="badge">SIMULATION</span>
        <nav className="dashnav simnav">
          <Link to="/">Live queue</Link>
          <Link to="/dispatch">Dispatcher dashboard</Link>
        </nav>
      </header>
      <p className="muted">
        Virtual NFC stickers. Tap one with the phone to send the same request a real sticker tap will. One-sticker
        demo: tap <strong>Join queue</strong>, then tap it again after 30 seconds to get “Boarding now?”.
      </p>

      <a className="simcount" href="/" target="_blank" rel="noreferrer">
        {stopError ? (
          <span className="warn">Live count unavailable right now, retrying… Taps still work and are saved.</span>
        ) : (
          <>
            <span className="num">{stopA?.queue_length ?? 0}</span>
            <span>
              in the queue at Stop A{stopA?.est_wait_min ? ` · about ${stopA.est_wait_min} min wait` : ''} · open live view
            </span>
          </>
        )}
      </a>
      {simError && (
        <p className="warn" role="alert">
          {simError}
        </p>
      )}

      <div className="simgrid">
        <section aria-label="Stickers">
          {stickers.length === 0 && <p className="muted">No stickers found in tags/tags.csv.</p>}
          <ul className="tags">
            {stickers.map((s) => (
              <li key={s.tag_id}>
                <button className={`sticker ${reading === s.tag_id ? 'reading' : ''}`} onClick={() => tap(s)}>
                  <span className="nfc" aria-hidden>
                    ))
                  </span>
                  <span className="stext">
                    <strong>{TAG_LABEL[s.tag_type]}</strong>
                    <code>{s.tag_id}</code>
                    <small>
                      NDEF {s.bytes.length}/{NTAG213_USER_BYTES} bytes · {toHex(s.bytes.slice(0, 8))} …
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="studentbar">
            <span>
              Phone holder: <strong>Student {student}</strong>
            </span>
            <button className="secondary" onClick={newStudent}>
              New student
            </button>
          </div>

          <h2 className="logh">Tap log</h2>
          {log.length === 0 ? (
            <p className="muted">No taps yet.</p>
          ) : (
            <ol className="log">
              {log.map((e, i) => (
                <li key={i} className={e.kind}>
                  <span>S{e.student}</span>
                  <code>{e.tag_id}</code>
                  <span>{e.data?.event_type ?? e.data?.code ?? e.kind}</span>
                  <span>{e.data?.flagged ? 'flagged' : ''}</span>
                  <span className="muted">{formatMYT(e.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="phone" aria-label="Virtual phone" ref={phoneRef}>
          <div className="screen">
            {phoneUrl ? (
              <iframe key={tapKey} title="Phone" src={phoneUrl} />
            ) : (
              <div className="idle">
                <p>Hold near a sticker</p>
                <p className="muted">Pick a sticker on the left.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
