// The one place that talks to an AI model. Server-side only: keys and tokens never reach the browser.
//
// AI_PROVIDER picks the backend:
//   gemini-api  Gemini API with a Google AI Studio key (free tier). Needs GEMINI_API_KEY.
//   vertex      Gemini on Vertex AI (Google Cloud). Needs a service account and a project with the
//               Vertex AI API enabled (Vertex AI needs billing turned on for that project).
//   template    No AI call; the caller shows its fixed template.
// Unset: gemini-api when GEMINI_API_KEY is set, otherwise template.
// To move to another Gemini endpoint (e.g. Gemini Enterprise), change only this file.

// gemini-flash-lite-latest is last: fast and usually free of "high demand" errors.
const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
// Total time for all attempts. Flash models "think" before answering; Vercel maxDuration is 60 s.
export const TIMEOUT_MS = 50_000;

/** Thrown when no call was attempted (provider off or not configured), so the reason is a setup fact. */
export class NotConfigured extends Error {}

// Pasted or imported keys often carry quotes, spaces or a newline; Google rejects those.
const clean = (v) => (v ?? '').trim().replace(/^["']|["']$/g, '').trim();

export function providerFor(env = process.env) {
  const p = clean(env.AI_PROVIDER).toLowerCase();
  if (p) return p;
  return clean(env.GEMINI_API_KEY) ? 'gemini-api' : 'template';
}

function modelsFor(env) {
  const list = (env.GEMINI_MODEL || '').split(',').map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

/**
 * Ask the configured model for JSON that matches `schema`, then check it with `validate` (throws if bad).
 * Models are tried in order: an overloaded (503), rate-limited (429), missing (404), slow or invalid answer
 * moves on to the next one. Returns { value, model, provider }. Throws if nothing usable came back.
 */
export async function generateJson({ system, prompt, schema, validate }, env = process.env, opts = {}) {
  const provider = providerFor(env);
  const target =
    provider === 'template'
      ? null
      : provider === 'gemini-api'
        ? geminiApi(env)
        : provider === 'vertex'
          ? await vertex(env, opts)
          : null;
  if (provider === 'template') throw new NotConfigured('AI_PROVIDER is set to template');
  if (!target) throw new NotConfigured(`Unknown AI_PROVIDER "${provider}" (use gemini-api, vertex or template)`);

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + TIMEOUT_MS;
  const errors = [];
  for (const model of modelsFor(env)) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    try {
      const res = await fetchImpl(target.url(model), {
        method: 'POST',
        // Credentials in a header, never the URL, so they don't show up in request logs.
        headers: { 'content-type': 'application/json', ...target.headers },
        body,
        signal: AbortSignal.timeout(left),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('');
      return { value: validate(JSON.parse(text)), model: data.modelVersion || model, provider };
    } catch (err) {
      const msg = target.mask(String(err.message || err)).replace(/\s+/g, ' ').slice(0, 200);
      console.warn(JSON.stringify({ severity: 'WARNING', msg: 'ai: model failed', provider, model, err: msg }));
      errors.push(`${model}: ${msg}`);
      if (/HTTP (401|403)\b/.test(msg) || /API key not valid/i.test(msg)) break; // bad credentials: every model fails the same way
    }
  }
  throw new Error(errors.join(' | ') || 'no time left to call the model');
}

function geminiApi(env) {
  const key = clean(env.GEMINI_API_KEY);
  if (!key) return null;
  return {
    url: (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
    headers: { 'x-goog-api-key': key },
    mask: (s) => s.split(key).join('***'),
  };
}

async function vertex(env, { getVertexToken } = {}) {
  let sa = null;
  try {
    sa = JSON.parse(env.VERTEX_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT || 'null');
  } catch {}
  if (!sa?.private_key) throw new NotConfigured('Vertex AI needs VERTEX_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT');
  const project = clean(env.VERTEX_PROJECT) || sa.project_id;
  const loc = clean(env.VERTEX_LOCATION) || 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  // firebase-admin is already a dependency; its credential gives a cloud-platform access token.
  const token = getVertexToken
    ? await getVertexToken(sa)
    : (await (await import('firebase-admin/app')).cert(sa).getAccessToken()).access_token;
  return {
    url: (m) =>
      `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${loc}/publishers/google/models/${encodeURIComponent(m)}:generateContent`,
    headers: { authorization: `Bearer ${token}` },
    mask: (s) => s.split(token).join('***'),
  };
}
