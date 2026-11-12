import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTags, readTags } from '../src/tags.js';

// Minimal Firestore stand-in: getAll, batch().set(ref, data, { merge }).
function fakeDb(existing) {
  const docs = new Map(Object.entries(existing));
  return {
    docs,
    collection: () => ({ doc: (id) => ({ id }) }),
    getAll: async (...refs) => refs.map((r) => ({ exists: docs.has(r.id), data: () => docs.get(r.id) })),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push([ref.id, data, opts]),
        commit: async () => ops.forEach(([id, d, o]) => docs.set(id, o?.merge ? { ...docs.get(id), ...d } : d)),
      };
    },
  };
}

test('seeding adds new tags and fixes the stop of an old driver tag, keeping "active"', async () => {
  const db = fakeDb({
    'bus01-driver': { tag_id: 'bus01-driver', tag_type: 'DRIVER', stop_id: null, bus_id: 'bus01', active: false },
  });
  const changed = await ensureTags(db);
  const csv = readTags();
  assert.equal(db.docs.get('bus01-driver').stop_id, 'stopA');
  assert.equal(db.docs.get('bus01-driver').active, false); // switched off in Firestore stays off
  assert.equal(db.docs.get('bus01-driver-lrt').stop_id, 'stopB');
  assert.equal(db.docs.get('stopB-q1').tag_type, 'QUEUE');
  assert.equal(changed, csv.length); // 1 fixed + the rest added
});
