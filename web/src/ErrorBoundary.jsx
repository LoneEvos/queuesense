import { Component } from 'react';
import { useLocation } from 'react-router-dom';

// Last line of defence: a render error shows a message instead of a blank page.
class Boundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    console.error('[page]', err);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="dash">
        <section className="errstate" role="alert">
          <h2>Something went wrong showing this page</h2>
          <p>Reload to try again. Taps are not affected: they are saved on the phone and sent separately.</p>
          <button className="secondary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}

// A new page starts with a clean slate: an error on one page does not stick to the next.
export default function ErrorBoundary({ children }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
