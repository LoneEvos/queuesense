import { Link } from 'react-router-dom';

export default function Placeholder({ title }) {
  return (
    <main className="home">
      <h1>{title}</h1>
      <p className="muted">Not built yet. Needs the processor and Firestore live state.</p>
      <Link to="/">Back</Link>
    </main>
  );
}
