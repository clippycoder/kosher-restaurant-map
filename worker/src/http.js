/** Request/response plumbing shared by every route. */

const MAX_BODY = 32 * 1024;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * Headers for an allowed origin; {} when there is no Origin (curl, the build
 * script); null when a browser on some other site is calling.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return { error: 'too large', status: 413 };
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 'too large', status: 413 };

  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  try {
    if (type === 'application/json') {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return { value };
    }
    if (type === 'application/x-www-form-urlencoded') {
      return { value: Object.fromEntries(new URLSearchParams(text)) };
    }
  } catch {
    return { error: 'malformed body', status: 400 };
  }
  return { error: 'unsupported content type', status: 415 };
}

/**
 * Canonical Turnstile siteverify (per Cloudflare's Turnstile Spin): the token
 * must verify, carry the action of the form it came from, and have been solved
 * on one of TURNSTILE_HOSTNAMES. Fails closed on anything else, including a
 * missing allowlist or an unreachable siteverify.
 *
 * Cloudflare's test keys (local development) return hostname "example.com"
 * and no action, flagged `result_with_testing_key`; only the action check is
 * waived for those. A production secret never returns that flag.
 */
export async function verifyTurnstile(env, token, ip, action) {
  const hostnames = new Set((env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean));
  if (typeof token !== 'string' || !token || token.length > 2048 || !hostnames.size) return false;

  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set('remoteip', ip);
  let result;
  try {
    const res = await fetch(TURNSTILE_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = await res.json();
  } catch (err) {
    console.error('turnstile', err?.message || err);
    return false;
  }
  const testing = result.metadata?.result_with_testing_key === true;
  const ok = result.success === true &&
    hostnames.has(result.hostname) &&
    (testing || result.action === action);
  // Error codes only; never the secret or the token.
  if (!ok) {
    console.warn('turnstile rejected', JSON.stringify({
      codes: result['error-codes'], hostname: result.hostname, action: result.action, expected: action,
    }));
  }
  return ok;
}

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compares digests, so timing reveals nothing about the token's content or length.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

/** Bearer-token check for admin routes. Returns an error Response, or null. */
export async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin is not configured' }, 503);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !(await safeEqual(token, env.ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401);
  return null;
}
