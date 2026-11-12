import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFacts, templateSummary, uncheckedNumbers, validateSummary, getInsights, clearInsightsCache } from './gemini.js';
import { DEFAULT_MODELS, providerFor } from './ai-provider.js';

const snapshot = JSON.parse(readFileSync(new URL('../sql/dispatch-snapshot.json', import.meta.url), 'utf8'));
const facts = buildFacts(snapshot);

beforeEach(() => clearInsightsCache());

const good = {
  summary: 'Mon 8am has the longest wait. Buses are full at peak. Mondays need more seats.',
  actions: [
    { action: 'Add 2 buses at Mon 7am', reason: 'Wait drops' },
    { action: 'Watch Tue 7am', reason: 'Busy' },
    { action: 'Review Mon', reason: 'Many left behind' },
  ],
  caveat: 'Simulated data.',
};

// A fake model API: returns the given JSON the way generateContent does (with a "thought" part to skip).
const fakeModel = (answer, { status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return { ok: false, status, text: async () => 'quota' };
    return {
      ok: true,
      json: async () => ({
        modelVersion: 'gemini-test',
        candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(answer) }] } }],
      }),
    };
  };
  return { fetchImpl, calls };
};

test('facts are aggregates only and flagged simulated', () => {
  assert.equal(facts.simulated, true);
  assert.equal(facts.longest_waits[0].when, 'Mon 8am');
  assert.ok(facts.recommended_changes.length > 0);
  assert.ok(!/hashed|user_id|uid|tag_id|event_id/i.test(JSON.stringify(facts)));
});

test('template: 3 sentences, 3 actions with reasons, a caveat, only numbers from the facts', () => {
  const s = templateSummary(facts);
  assert.deepEqual(validateSummary(s), s);
  assert.match(s.summary, /Mon 8am/);
  assert.equal(s.actions.length, 3);
  assert.deepEqual(uncheckedNumbers(s, facts), []);
});

test('empty dashboard data still gives a valid template, no crash', () => {
  const f = buildFacts({ source: 'snapshot', kpis: null, heatmap: [], left_behind_daily: [], forecast: [], recommendations: [] });
  const s = templateSummary(f);
  assert.deepEqual(validateSummary(s), s);
  assert.match(s.actions[0].action, /Keep the current timetable/);
});

test('validation rejects a wrong shape', () => {
  assert.throws(() => validateSummary(null));
  assert.throws(() => validateSummary({ ...good, actions: good.actions.slice(0, 2) }), /3 actions/);
  assert.throws(() => validateSummary({ ...good, actions: [...good.actions.slice(0, 2), { action: 'x' }] }), /3 actions/);
  assert.throws(() => validateSummary({ ...good, summary: 'One sentence only.' }), /sentences/);
  assert.throws(() => validateSummary({ ...good, caveat: '' }), /caveat/);
  assert.equal(validateSummary({ ...good, actions: [...good.actions, good.actions[0]] }).actions.length, 3);
});

test('unchecked numbers catches invented values but allows rounding', () => {
  const s = { ...good, summary: 'Average wait is about 9 min. Wait rises 37% at 7am. 5,519 left behind.' };
  assert.deepEqual(uncheckedNumbers(s, facts), [37]);
});

test('AI_PROVIDER: explicit value wins, otherwise gemini-api only when a key is set', () => {
  assert.equal(providerFor({}), 'template');
  assert.equal(providerFor({ GEMINI_API_KEY: 'k' }), 'gemini-api');
  assert.equal(providerFor({ GEMINI_API_KEY: 'k', AI_PROVIDER: 'Template' }), 'template');
  assert.equal(providerFor({ AI_PROVIDER: 'vertex' }), 'vertex');
});

test('no key: template, no network call', async () => {
  const { fetchImpl, calls } = fakeModel(good);
  const r = await getInsights(snapshot, {}, { fetchImpl });
  assert.equal(r.source, 'template');
  assert.equal(r.simulated, true);
  assert.equal(calls.length, 0);
});

test('AI_PROVIDER=template: template even with a key', async () => {
  const { fetchImpl, calls } = fakeModel(good);
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k', AI_PROVIDER: 'template' }, { fetchImpl });
  assert.equal(r.source, 'template');
  assert.match(r.reason, /template/);
  assert.equal(calls.length, 0);
});

test('gemini-api: answer used, key sent in a header, thoughts skipped, cached', async () => {
  const { fetchImpl, calls } = fakeModel(good);
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(r.source, 'gemini');
  assert.equal(r.provider, 'gemini-api');
  assert.equal(r.model, 'gemini-test');
  assert.equal(r.summary, good.summary);
  assert.equal(r.actions.length, 3);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'k');
  assert.ok(!calls[0].url.includes('k='));
  await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(calls.length, 1);
});

test('vertex: same request to the Vertex AI endpoint with a bearer token', async () => {
  const { fetchImpl, calls } = fakeModel(good);
  const sa = JSON.stringify({ project_id: 'my-proj', private_key: 'x', client_email: 'a@b' });
  const r = await getInsights(
    snapshot,
    { AI_PROVIDER: 'vertex', FIREBASE_SERVICE_ACCOUNT: sa, GEMINI_MODEL: 'gemini-x' },
    { fetchImpl, getVertexToken: async () => 'tok' },
  );
  assert.equal(r.source, 'gemini');
  assert.equal(r.provider, 'vertex');
  assert.equal(calls[0].url, 'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-x:generateContent');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

test('vertex without a service account: template with a setup reason', async () => {
  const r = await getInsights(snapshot, { AI_PROVIDER: 'vertex' }, { fetchImpl: fakeModel(good).fetchImpl });
  assert.equal(r.source, 'template');
  assert.match(r.reason, /VERTEX_SERVICE_ACCOUNT/);
});

test('API error falls back to the template', async () => {
  const { fetchImpl } = fakeModel(good, { status: 429 });
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(r.source, 'template');
  assert.equal(r.reason, 'The AI model did not answer');
  assert.match(r.error, /429/);
});

test('an invalid answer falls through to the next model, then the template', async () => {
  const { fetchImpl, calls } = fakeModel({ summary: 'Too short.', actions: [], caveat: '' });
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.equal(calls.length, DEFAULT_MODELS.length); // every default model tried
  assert.equal(r.source, 'template');
  assert.match(r.error, /sentences|actions/);
});

test('an overloaded model falls through to the next one', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 503, text: async () => 'high demand' };
    return { ok: true, json: async () => ({ modelVersion: 'backup', candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] }) };
  };
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'k' }, { fetchImpl });
  assert.match(calls[0], /gemini-3\.6-flash/);
  assert.equal(r.model, 'backup');
});

test('quoted key with a newline is cleaned before use; the key never appears in errors', async () => {
  const { fetchImpl, calls } = fakeModel(good);
  await getInsights(snapshot, { GEMINI_API_KEY: ' "abc123"\n' }, { fetchImpl });
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'abc123');
  clearInsightsCache();
  const leak = async () => ({ ok: false, status: 400, text: async () => 'API key not valid: abc123' });
  const r = await getInsights(snapshot, { GEMINI_API_KEY: 'abc123' }, { fetchImpl: leak });
  assert.ok(!r.error.includes('abc123'));
});
