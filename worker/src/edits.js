/**
 * Edits of rest.jdn.co.il restaurants, and the version of them we keep.
 *
 * An edit carries only the fields it changes. Each changed field is decided on
 * its own: it is accepted when a second, different person submits the same
 * value against the same jdn value, or when the moderator approves it. Until
 * then it is pending and nothing on the map changes.
 *
 * "Different person" means a different fingerprint (salted IP hash) AND at
 * least an hour apart. The IP alone is weak -- one person switching from Wi-Fi
 * to mobile data has two -- and independent reports are rarely minutes apart.
 *
 * Accepted values form our version of the restaurant, one row per field. Each
 * row remembers the jdn value it replaced (`base`); when jdn changes that
 * field, theirs wins and our value for that field is dropped. Our values for
 * the restaurant's other fields stay.
 */

import { EDIT_FIELDS, EDITABLE, matchKey, normalizePhone } from '../../public/forms/fields.js';
import { jdnRecords, asFields } from './dataset.js';
import { spamFlags } from './screen.js';
import { intake } from './intake.js';
import { json, readBody } from './http.js';

const PHONE_FIELDS = new Set(['phone', 'whatsapp']);
export const CORROBORATION_GAP_MS = 60 * 60 * 1000;

/** "The same info": phones compare as numbers, everything else ignoring case, spacing and punctuation. */
export function sameValue(field, a, b) {
  if (PHONE_FIELDS.has(field)) {
    const x = normalizePhone(a);
    const y = normalizePhone(b);
    if (x && y) return x === y;
  }
  return matchKey(a) === matchKey(b);
}

const jdnValue = (fields, key) => fields[key] ?? '';

/**
 * Drop whatever jdn has overtaken for this restaurant: our accepted values,
 * and pending edits, whose field jdn has since changed.
 */
async function retireOvertaken(env, restaurant, jdnFields, now) {
  const { results: rows } = await env.DB.prepare(
    'SELECT field, base FROM versions WHERE restaurant = ?',
  ).bind(restaurant).all();
  for (const row of rows) {
    if (!sameValue(row.field, row.base, jdnValue(jdnFields, row.field))) {
      await env.DB.prepare('DELETE FROM versions WHERE restaurant = ? AND field = ?')
        .bind(restaurant, row.field).run();
    }
  }

  const { results: pending } = await env.DB.prepare(
    "SELECT edit_id, field, base FROM edit_fields WHERE restaurant = ? AND status = 'pending'",
  ).bind(restaurant).all();
  for (const row of pending) {
    if (!sameValue(row.field, row.base, jdnValue(jdnFields, row.field))) {
      await env.DB.prepare(
        "UPDATE edit_fields SET status = 'stale', decided_at = ? WHERE edit_id = ? AND field = ?",
      ).bind(now, row.edit_id, row.field).run();
    }
  }
}

async function saveVersion(env, restaurant, field, value, base, now) {
  await env.DB.prepare(
    `INSERT INTO versions (restaurant, field, value, base, accepted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (restaurant, field) DO UPDATE
       SET value = excluded.value, base = excluded.base, accepted_at = excluded.accepted_at`,
  ).bind(restaurant, field, value, base, now).run();
}

// --- public ---------------------------------------------------------------

export async function submitEdit(request, env, cors) {
  const r = await intake(request, env, cors, 'edits', EDIT_FIELDS);
  if (r.response) return r.response;
  const { v, clientHash } = r;
  const now = r.now.toISOString();
  const restaurant = v.public.restaurant;

  let records;
  try {
    records = await jdnRecords(env);
  } catch (err) {
    console.error('dataset', err);
    return json({ error: 'temporarily unavailable' }, 503, cors);
  }
  const rec = records.get(restaurant);
  if (!rec) return json({ error: 'invalid', fields: { restaurant: 'מסעדה לא נמצאה' } }, 422, cors);
  const jdnFields = asFields(rec);

  await retireOvertaken(env, restaurant, jdnFields, now);

  // What the map shows now: jdn's record with our surviving values on top.
  const { results: ours } = await env.DB.prepare(
    'SELECT field, value FROM versions WHERE restaurant = ?',
  ).bind(restaurant).all();
  const shown = { ...jdnFields, ...Object.fromEntries(ours.map((o) => [o.field, o.value])) };

  const changes = EDITABLE
    .filter((k) => k in v.public && !sameValue(k, v.public[k], shown[k] ?? ''))
    .map((k) => ({ field: k, value: v.public[k], base: jdnValue(jdnFields, k) }));
  if (!changes.length) return json({ error: 'no changes' }, 422, cors);

  const flags = spamFlags(Object.fromEntries(changes.map((c) => [c.field, c.value])));

  const res = await env.DB.prepare(
    'INSERT INTO edits (restaurant, private, flags, created_at, client_hash) VALUES (?, ?, ?, ?, ?)',
  ).bind(restaurant, JSON.stringify(v.private), JSON.stringify(flags), now, clientHash).run();
  const editId = res.meta.last_row_id;
  for (const c of changes) {
    await env.DB.prepare(
      'INSERT INTO edit_fields (edit_id, restaurant, field, value, base) VALUES (?, ?, ?, ?, ?)',
    ).bind(editId, restaurant, c.field, c.value, c.base).run();
  }

  // A flagged edit waits for the moderator; it neither confirms nor is confirmed.
  const accepted = [];
  if (!flags.length) {
    for (const c of changes) {
      const { results: others } = await env.DB.prepare(
        `SELECT ef.edit_id, ef.value, ef.base FROM edit_fields ef JOIN edits e ON e.id = ef.edit_id
         WHERE ef.restaurant = ? AND ef.field = ? AND ef.status = 'pending' AND ef.edit_id != ?
           AND e.flags = '[]' AND e.client_hash IS NOT NULL AND e.client_hash != ?
           AND e.created_at <= ?
         ORDER BY ef.edit_id`,
      ).bind(restaurant, c.field, editId, clientHash,
        new Date(r.now.getTime() - CORROBORATION_GAP_MS).toISOString()).all();
      const agreeing = others.filter((o) =>
        sameValue(c.field, o.value, c.value) && sameValue(c.field, o.base, c.base));
      if (!agreeing.length) continue;

      // The earliest wording wins; every edit that agreed is marked accepted.
      for (const id of [editId, ...agreeing.map((o) => o.edit_id)]) {
        await env.DB.prepare(
          `UPDATE edit_fields SET status = 'accepted', decided_by = 'corroborated', decided_at = ?
           WHERE edit_id = ? AND field = ?`,
        ).bind(now, id, c.field).run();
      }
      await saveVersion(env, restaurant, c.field, agreeing[0].value, c.base, now);
      accepted.push(c.field);
    }
  }

  return json({
    ok: true,
    id: editId,
    accepted,
    pending: changes.map((c) => c.field).filter((f) => !accepted.includes(f)),
  }, 201, cors);
}

/**
 * Our version of every edited restaurant, for the build:
 * { "2699": { "phone": { "value": "...", "base": "<jdn value it replaced>" } } }.
 * The build applies a value only while jdn's current value still matches `base`.
 */
export async function publicVersions(env, cors) {
  const { results } = await env.DB.prepare(
    'SELECT restaurant, field, value, base, accepted_at FROM versions ORDER BY restaurant, field',
  ).all();
  const versions = {};
  for (const r of results) {
    (versions[r.restaurant] ??= {})[r.field] = { value: r.value, base: r.base, acceptedAt: r.accepted_at };
  }
  return json({ generated: new Date().toISOString(), versions }, 200,
    { ...cors, 'cache-control': 'public, max-age=300' });
}

// --- admin ----------------------------------------------------------------

async function editView(env, row) {
  const { results } = await env.DB.prepare(
    'SELECT field, value, base, status, decided_by, decided_at FROM edit_fields WHERE edit_id = ? ORDER BY field',
  ).bind(row.id).all();
  return {
    id: row.id,
    restaurant: row.restaurant,
    flags: JSON.parse(row.flags),
    private: JSON.parse(row.private),
    createdAt: row.created_at,
    reviewNote: row.review_note,
    fields: results.map((f) => ({
      field: f.field, value: f.value, base: f.base, status: f.status,
      decidedBy: f.decided_by, decidedAt: f.decided_at,
    })),
  };
}

/** /api/admin/edits[/:id] and /api/admin/versions[/:restaurant[/:field]]. */
export async function adminEdits(request, env, url) {
  const p = url.pathname;

  let m = p.match(/^\/api\/admin\/versions(?:\/(\d+)(?:\/(\w+))?)?$/);
  if (m) {
    const [, restaurant, field] = m;
    if (request.method === 'GET' && !restaurant) {
      const { results } = await env.DB.prepare('SELECT * FROM versions ORDER BY restaurant, field').all();
      return json({ versions: results });
    }
    if (request.method === 'DELETE' && restaurant) {
      const res = field
        ? await env.DB.prepare('DELETE FROM versions WHERE restaurant = ? AND field = ?').bind(restaurant, field).run()
        : await env.DB.prepare('DELETE FROM versions WHERE restaurant = ?').bind(restaurant).run();
      return json({ ok: true, removed: res.meta.changes });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  m = p.match(/^\/api\/admin\/edits(?:\/(\d+))?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = m[1] ? Number(m[1]) : null;

  if (id === null) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'all'].includes(status)) return json({ error: 'bad status' }, 400);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const { results } = await env.DB.prepare(
      `SELECT * FROM edits e WHERE ? = 'all'
         OR EXISTS (SELECT 1 FROM edit_fields f WHERE f.edit_id = e.id AND f.status = 'pending')
       ORDER BY id DESC LIMIT ?`,
    ).bind(status, limit).all();
    const edits = [];
    for (const row of results) edits.push(await editView(env, row));
    return json({ edits });
  }

  const row = await env.DB.prepare('SELECT * FROM edits WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);

  if (request.method === 'GET') return json(await editView(env, row));

  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM edit_fields WHERE edit_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM edits WHERE id = ?').bind(id).run();
    return json({ ok: true, deleted: id });
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, body.status);
  const { action, fields: only = null, note = null } = body.value;
  if (!['accept', 'reject'].includes(action)) return json({ error: 'action must be accept or reject' }, 400);

  const { results: all } = await env.DB.prepare(
    "SELECT field, value FROM edit_fields WHERE edit_id = ? AND status != 'accepted'",
  ).bind(id).all();
  const targets = Array.isArray(only) ? all.filter((f) => only.includes(f.field)) : all;
  if (!targets.length) return json({ error: 'nothing left to decide' }, 400);

  const now = new Date().toISOString();
  let jdnFields = null;
  if (action === 'accept') {
    // The moderator's acceptance applies against jdn's value as it is now.
    try {
      const rec = (await jdnRecords(env)).get(row.restaurant);
      if (!rec) return json({ error: 'restaurant no longer on the map' }, 409);
      jdnFields = asFields(rec);
    } catch (err) {
      console.error('dataset', err);
      return json({ error: 'dataset unavailable' }, 503);
    }
  }

  for (const f of targets) {
    await env.DB.prepare(
      `UPDATE edit_fields SET status = ?, decided_by = 'moderator', decided_at = ?
       WHERE edit_id = ? AND field = ?`,
    ).bind(action === 'accept' ? 'accepted' : 'rejected', now, id, f.field).run();
    if (action === 'accept') {
      await saveVersion(env, row.restaurant, f.field, f.value, jdnValue(jdnFields, f.field), now);
    }
  }
  if (note !== null) {
    await env.DB.prepare('UPDATE edits SET review_note = ? WHERE id = ?').bind(String(note), id).run();
  }
  return json(await editView(env, await env.DB.prepare('SELECT * FROM edits WHERE id = ?').bind(id).first()));
}
