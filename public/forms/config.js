/** Where the form sends things. Local preview talks to `wrangler dev`. */

const local = ['localhost', '127.0.0.1'].includes(location.hostname);

export const API_BASE = local
  ? 'http://localhost:8787'
  : 'https://kosher-map-submissions.clippycoder.workers.dev';

// Cloudflare Turnstile (managed mode, created with Turnstile Spin). Locally,
// Cloudflare's published always-pass test key.
export const TURNSTILE_SITE_KEY = local ? '1x00000000000000000000AA' : '0x4AAAAAAFQjybmfE9B63NwH';

// Must match the worker's ACTIONS; siteverify rejects a token from another form.
export const TURNSTILE_ACTION = 'add';
export const TURNSTILE_ACTIONS = { add: 'add', edit: 'edit', report: 'report' };
