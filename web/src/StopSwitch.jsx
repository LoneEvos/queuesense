import { Link } from 'react-router-dom';
import { STOPS } from './tags.js';

// Pick a stop: links (when each stop has its own URL) or buttons (when the page keeps the choice in state).
export default function StopSwitch({ value, onPick, linkFor }) {
  return (
    <nav className="chips stopswitch" aria-label="Stop">
      {STOPS.map((s) => {
        const on = s.id === value;
        const label = (
          <>
            {s.name} <span className="route">{s.route}</span>
          </>
        );
        return linkFor ? (
          <Link key={s.id} to={linkFor(s.id)} className={on ? 'chip on' : 'chip'} aria-current={on ? 'page' : undefined}>
            {label}
          </Link>
        ) : (
          <button key={s.id} className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => onPick(s.id)}>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
