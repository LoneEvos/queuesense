import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFacts, templateSummary, uncheckedNumbers, getInsights, clearInsightsCache } from './gemini.js';

const snapshot = JSON.parse(readFileSync(new URL('../sql/dispatch-snapshot.json', import.meta.url), 'utf8'));
const facts = buildFacts(snapshot);

beforeEach(() => clearInsightsCache());

// A fake Gemini API: returns the given summary the way generateContent does.
const fakeGemini = (summary, { status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return { ok: false, status, text: async () => 'quota' };
    return {
      ok: true,
      json: async () => ({
        modelVersion: 'gemini-test',
        candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(summary) }] } }],
      }),
    };
  };
  return { fetchImpl, calls };
};

test('facts are aggregates only and flagged simulated', () => {
  assert.equal(facts.simulated, true);
  assert.equal(facts.longest_waits[0].when, 'Mon 8am');
  assert.equal(facts.recommended_changes.length, 3);
  assert.ok(!/hashed|user_id|uid/i.test(JSON.stringify(facts)));
});

test('template summary uses only numbers from the facts', () => {
  const s = templateSummary(facts);
  assert.match(s.headline, /Mon 8am/);
  assert.equal(s.points.length, 3);
  assert.deepEqual(uncheckedNumbers(s, facts), []);
});

test('unchecked numbers catches invented values but allows rounding', () => {
  const s = { headline: 'Average wait is about 9 min', points: ['Wait rises 37% at 7am', '5,519 left behind'], action: 'Add 2 buses' };
  assert.deepEqual(uncheckedNumbers(s, facts), [37]);
});

test('no API key: template, no network call', async () => {
  const { fetchImpl, calls } = fakeGemini({});
  const r = await getInsights(snapshot, {}, { fetchImpl });
  assert.equal(r.source, 'template');
  assert.equal(r.simulated, true);
  assert.equal(calls.length, 0);
});

test('Gemini answer is used, key sent in a header, thoughts skipped', async () => {
  const summary = { headline: 'Mon 7am is worst', points: ['a', 'b', 'c'], action: 'Add 2 buses' };
  const { fetchImpl, calls } = fakeGemini(summary);
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(r.source, 'gemini');
  assert.equal(r.model, 'gemini-test');
  assert.equal(r.headline, summary.headline);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'k');
  assert.ok(!calls[0].url.includes('k='));
  // Cached: a second request does not call Gemini again.
  await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(calls.length, 1);
});

test('Gemini error falls back to the template', async () => {
  const { fetchImpl } = fakeGemini({}, { status: 429 });
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(r.source, 'template');
  assert.equal(r.reason, 'Gemini did not answer');
});
