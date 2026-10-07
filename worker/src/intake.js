/**
 * The shared front half of every public POST: config, body, honeypot,
 * validation, captcha, rate limit.
 */

import { validate, HONEYPOT } from '../../public/forms/fields.js';
import { json, readBody, verifyTurnstile, sha256hex } from './http.js';

// Per person per rolling 24 hours, and in total per UTC day (protects the free tier).
const LIMITS = {
  submissions: { perClient: 5, global: 300 },
  reports: { perClient: 10, global: 500 },
  edits: { perClient: 10, global: 500 },
};

// The Turnstile action each form's widget is rendered with, checked by siteverify.
export const ACTIONS = { submissions: 'add', edits: 'edit', reports: 'report' };

// How long the anonymised submitter fingerprint is kept.
export const CLIENT_HASH_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Returns { response } to stop, or { v, clientHash, now } to carry on.
 *
 * The fingerprint is SHA-256(secret salt, IP): stable for one person so two
 * edits can be told apart as coming from different people, never the raw IP,
 * and cleared after 30 days.
 */
export async function intake(request, env, cors, table, fields) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_HOSTNAMES || !env.RATE_SALT) {
    return { response: json({ error: 'not configured' }, 503, cors) };
  }

  const body = await readBody(request);
  if (body.error) return { response: json({ error: body.error }, body.status, cors) };
  const input = body.value;

  // Bots that fill every field get a success they can't tell from a real one.
  if (String(input[HONEYPOT] ?? '').trim()) {
    return { response: json({ ok: true }, 201, cors) };
  }

  // Validate before the captcha: a token is single-use, so a typo shouldn't burn it.
  const v = validate(input, fields);
  if (Object.keys(v.errors).length) {
    return { response: json({ error: 'invalid', fields: v.errors }, 422, cors) };
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, input['cf-turnstile-response'], ip, ACTIONS[table]))) {
    return { response: json({ error: 'captcha failed' }, 403, cors) };
  }

  const now = new Date();
  const clientHash = await sha256hex(`${env.RATE_SALT}|${ip}`);
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const limit = LIMITS[table];

  const { mine } = await env.DB.prepare(
    `SELECT COUNT(*) AS mine FROM ${table} WHERE client_hash = ? AND created_at >= ?`,
  ).bind(clientHash, dayAgo).first();
  if (mine >= limit.perClient) {
    return { response: json({ error: 'too many today' }, 429, cors) };
  }
  const { total } = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM ${table} WHERE created_at >= ?`,
  ).bind(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).first();
  if (total >= limit.global) {
    return { response: json({ error: 'daily limit reached' }, 503, cors) };
  }

  return { v, clientHash, now };
}

export async function purgeClientHashes(env, now = Date.now()) {
  const cutoff = new Date(now - CLIENT_HASH_TTL_MS).toISOString();
  for (const table of [...Object.keys(LIMITS), 'confirmations']) {
    await env.DB.prepare(
      `UPDATE ${table} SET client_hash = NULL WHERE client_hash IS NOT NULL AND created_at < ?`,
    ).bind(cutoff).run();
  }
}
