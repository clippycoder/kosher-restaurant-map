/**
 * "Is this correct?" on community listings. One click, no captcha: each
 * person (salted IP fingerprint) counts once per listing, with daily limits.
 * At CONFIRMATIONS_NEEDED distinct people the listing is verified and the
 * question stops being asked. Whoever submitted the listing (same
 * fingerprint) can't confirm it; the popup doesn't ask them. Fingerprints
 * change with the network and are cleared after 30 days, so this catches the
 * same person on the same connection, not every case. Someone with many internet connections could
 * fake confirmations; the stakes (a button disappearing) are low.
 *
 *   GET  /api/confirmations/c<id>   { count, needed, verified, mine, own }
 *   POST /api/confirmations         { restaurant: "c<id>" } -> the same, after counting
 */

import { json, readBody, sha256hex } from './http.js';

export const CONFIRMATIONS_NEEDED = 5;
const LIMIT = { perClient: 30, global: 3000 };

const REF = /^c\d{1,9}$/;

/** A published community listing (not a shadow), or null. */
async function communityListing(env, ref) {
  if (!REF.test(ref || '')) return null;
  return env.DB.prepare(
    "SELECT id, verified_at, client_hash FROM submissions WHERE id = ? AND shadows IS NULL AND status = 'published'",
  ).bind(Number(ref.slice(1))).first();
}

const fingerprint = (env, request) =>
  sha256hex(`${env.RATE_SALT}|${request.headers.get('CF-Connecting-IP') || ''}`);

async function state(env, ref, row, clientHash) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM confirmations WHERE restaurant = ?')
    .bind(ref).first();
  const mine = !!(await env.DB.prepare(
    'SELECT 1 AS x FROM confirmations WHERE restaurant = ? AND client_hash = ?',
  ).bind(ref, clientHash).first());
  const own = !!row.client_hash && row.client_hash === clientHash;
  return { restaurant: ref, count: n, needed: CONFIRMATIONS_NEEDED, verified: !!row.verified_at, mine, own };
}

export async function confirmationState(request, env, cors, ref) {
  if (!env.RATE_SALT) return json({ error: 'not configured' }, 503, cors);
  const row = await communityListing(env, ref);
  if (!row) return json({ error: 'not found' }, 404, cors);
  return json(await state(env, ref, row, await fingerprint(env, request)), 200, cors);
}

export async function confirm(request, env, cors) {
  if (!env.RATE_SALT) return json({ error: 'not configured' }, 503, cors);
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, body.status, cors);
  const ref = String(body.value.restaurant || '');
  const row = await communityListing(env, ref);
  if (!row) return json({ error: 'invalid', fields: { restaurant: 'not_found' } }, 422, cors);

  const clientHash = await fingerprint(env, request);
  if (row.verified_at) return json(await state(env, ref, row, clientHash), 200, cors);
  // Nobody vouches for their own submission.
  if (row.client_hash && row.client_hash === clientHash) {
    return json({ error: 'own listing', ...(await state(env, ref, row, clientHash)) }, 403, cors);
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const { mine } = await env.DB.prepare(
    'SELECT COUNT(*) AS mine FROM confirmations WHERE client_hash = ? AND created_at >= ?',
  ).bind(clientHash, dayAgo).first();
  if (mine >= LIMIT.perClient) return json({ error: 'too many today' }, 429, cors);
  const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM confirmations WHERE created_at >= ?')
    .bind(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).first();
  if (total >= LIMIT.global) return json({ error: 'daily limit reached' }, 503, cors);

  // Once per person per listing; a second click is a no-op.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO confirmations (restaurant, client_hash, created_at) VALUES (?, ?, ?)',
  ).bind(ref, clientHash, now.toISOString()).run();

  const s = await state(env, ref, row, clientHash);
  if (s.count >= CONFIRMATIONS_NEEDED) {
    await env.DB.prepare('UPDATE submissions SET verified_at = ? WHERE id = ? AND verified_at IS NULL')
      .bind(now.toISOString(), row.id).run();
    s.verified = true;
  }
  return json(s, 201, cors);
}

/** An accepted correction changes what people confirmed: start counting again. */
export async function resetConfirmations(env, ref, id) {
  await env.DB.prepare('DELETE FROM confirmations WHERE restaurant = ?').bind(ref).run();
  await env.DB.prepare('UPDATE submissions SET verified_at = NULL WHERE id = ?').bind(id).run();
}
