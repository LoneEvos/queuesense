// Tag registry seed: make sure every sticker in tags/tags.csv exists in Firestore tags/{tag_id}.
// Runs once per server start. Adds missing tags and syncs tag_type, stop_id and bus_id from the CSV,
// but never changes "active" on an existing tag (so you can switch one off in Firestore).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSV = fileURLToPath(new URL('../../tags/tags.csv', import.meta.url));

export function readTags(path = CSV) {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = header.split(',');
  return rows.map((line) => {
    const r = Object.fromEntries(line.split(',').map((v, i) => [cols[i], v]));
    return {
      tag_id: r.tag_id,
      tag_type: r.tag_type,
      stop_id: r.stop_id || null,
      bus_id: r.bus_id || null,
      active: r.active === 'true',
    };
  });
}

let done = null;
export function ensureTags(db) {
  done ??= (async () => {
    const tags = readTags();
    const refs = tags.map((t) => db.collection('tags').doc(t.tag_id));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    let changed = 0;
    snaps.forEach((s, i) => {
      const t = tags[i];
      if (!s.exists) {
        batch.set(refs[i], t);
        changed++;
        return;
      }
      const cur = s.data();
      if (cur.tag_type !== t.tag_type || (cur.stop_id ?? null) !== t.stop_id || (cur.bus_id ?? null) !== t.bus_id) {
        batch.set(refs[i], { tag_type: t.tag_type, stop_id: t.stop_id, bus_id: t.bus_id }, { merge: true });
        changed++;
      }
    });
    if (changed) await batch.commit();
    return changed;
  })().catch((err) => {
    done = null; // try again on the next request
    throw err;
  });
  return done;
}
