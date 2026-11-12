import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Home from './pages/Home.jsx';
import TapPage from './pages/TapPage.jsx';
import Placeholder from './pages/Placeholder.jsx';
import Live from './pages/Live.jsx';
import Dispatch from './pages/Dispatch.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { startBackgroundFlush } from './outbox.js';
import './styles.css';

// Send any taps saved while offline, now and whenever the connection returns.
startBackgroundFlush((r) => console.info('[outbox]', r.kind, r.tap.tag_id, r.data));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Live />} />
          <Route path="/sim" element={<Home />} />
          <Route path="/t/:tagId" element={<TapPage />} />
          <Route path="/live" element={<Live />} />
          <Route path="/live/:stopId" element={<Live />} />
          <Route path="/dispatch" element={<Dispatch />} />
          <Route path="*" element={<Placeholder title="Not found" />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);
