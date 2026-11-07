// Config from env. HASH_SALT must be a server-side secret, never in the repo or browser.
export function makeConfig(env = process.env, defaults = {}) {
  const config = {
    port: Number(env.PORT || 8081),
    projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || defaults.projectId || 'demo-queuesense',
    hashSalt: env.HASH_SALT || defaults.hashSalt || '',
    // While true, every event is stamped simulated=true (no real stickers yet).
    simulationMode: (env.SIMULATION_MODE ?? 'true') !== 'false',
    // Only needed when the web app is on a different origin (local dev without the Vite proxy).
    allowedOrigins: (env.ALLOWED_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (!config.hashSalt || config.hashSalt.length < 16) {
    throw new Error('HASH_SALT is missing or shorter than 16 chars.');
  }
  return config;
}
