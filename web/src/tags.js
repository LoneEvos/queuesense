// Sticker list, read from /tags/tags.csv so there is one source of truth.
// Used only for display and the simulation panel. Ingest decides what a tap means.
import csv from '../../tags/tags.csv?raw';

const [header, ...rows] = csv.trim().split(/\r?\n/);
const cols = header.split(',');

export const TAGS = rows.map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i], v])));

// Both ends of the shuttle route. The queue stickers in tags.csv define which stops exist.
const STOP_INFO = {
  stopA: { name: 'Stop A', route: 'APU → LRT' },
  stopB: { name: 'Stop B', route: 'LRT → APU' },
};
export const stopInfo = (id) => ({ id, name: `Stop ${id.replace(/^stop/, '')}`, route: '', ...STOP_INFO[id] });
export const STOPS = [...new Set(TAGS.filter((t) => t.tag_type === 'QUEUE').map((t) => t.stop_id))].map(stopInfo);

export const TAG_LABEL = { QUEUE: 'Join queue', BUS: 'Board bus', DRIVER: 'Bus departs' };

export function placeName(ev) {
  if (ev.stop_id) return `Stop ${ev.stop_id.replace(/^stop/, '')}`;
  if (ev.bus_id) return `Bus ${ev.bus_id.replace(/^bus/, '')}`;
  return '';
}

export function formatMYT(iso) {
  return new Date(iso).toLocaleTimeString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    minute: '2-digit',
  });
}
