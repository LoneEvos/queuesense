// Sticker list, read from /tags/tags.csv so there is one source of truth.
// Used only for display and the simulation panel. Ingest decides what a tap means.
import csv from '../../tags/tags.csv?raw';

const [header, ...rows] = csv.trim().split(/\r?\n/);
const cols = header.split(',');

export const TAGS = rows.map((line) => Object.fromEntries(line.split(',').map((v, i) => [cols[i], v])));

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
