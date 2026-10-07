/**
 * Corrections to listings, field by field -- the same for a rest.jdn.co.il
 * listing and for one of our own (community) listings.
 *
 * An edit carries only the fields it changes. Each changed field is decided on
 * its own: it is accepted when a second, different person submits the same
 * value against the same starting value, or when the moderator approves it.
 * Until then it is pending and nothing on the map changes.
 *
 * "Different person" means a different fingerprint (salted IP hash) AND at
 * least an hour apart. The IP alone is weak -- one person switching from Wi-Fi
 * to mobile data has two -- and independent reports are rarely minutes apart.
 *
 * Where an accepted value goes:
 *   community listing (c<id>)  -> straight into that listing's data
 *   jdn listing (<post id>)    -> its shadow: our own listing in `submissions`
 *                                 that follows the jdn one (`shadows` = its id),
 *                                 created by the first accepted correction. It
 *                                 holds a full copy of the listing with our
 *                                 corrections applied, and for each corrected
 *                                 field the jdn value it replaced (`base`).
 *
 * Shadows follow jdn: fields nobody corrected always show jdn's value; when jdn
 * changes a corrected field, jdn's value wins and our correction is dropped;
 * when jdn removes the listing, the shadow is held for the moderator, who can
 * keep it as a listing of our own. The nightly sync (syncShadows) does this,
 * and every new edit of a listing first retires what jdn has overtaken.
 */

import { EDIT_FIELDS, EDITABLE, sameValue, validate } from '../../public/forms/fields.js';
import { jdnRecords, asFields } from './dataset.js';
import { spamFlags } from './screen.js';
import { intake } from './intake.js';
import { json, readBody } from './http.js';
import { resetConfirmations } from './confirm.js';

export const CORROBORATION_GAP_MS = 60 * 60 * 1000;
export const REMOVED_FLAG = { kind: 'source', reason: 'removed from בהשגחה' };

const isCommunity = (ref) => ref.startsWith('c');
const parse = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

/**
 * The listing an edit is about: what the map shows now (`shown`), the value
 * each field's correction is measured against (`base`), and its rows.
 * Null when there is no such listing on the map.
 *
 *   jdn:        shown = jdn's record with our corrections on top;
 *               base  = jdn's own value (so we notice when jdn changes it)
 *   community:  shown = base = our listing's data
 */
async function listing(env, ref) {
  if (isCommunity(ref)) {
    const row = await env.DB.prepare(
      "SELECT * FROM submissions WHERE id = ? AND shadows IS NULL AND status = 'published'",
    ).bind(Number(ref.slice(1))).first();
    if (!row) return null;
    const data = parse(row.data, {});
    return { kind: 'community', ref, row, shown: data, base: (f) => data[f] ?? '' };
  }
  const rec = (await jdnRecords(env)).get(ref);
  if (!rec) return null;
  const jdn = asFields(rec);
  const shadow = await env.DB.prepare('SELECT * FROM submissions WHERE shadows = ?').bind(ref).first();
  const data = shadow ? parse(shadow.data, {}) : {};
  const corrections = shadow ? parse(shadow.corrections, {}) : {};
  const shown = { ...jdn };
  for (const f of Object.keys(corrections)) shown[f] = data[f];
  return { kind: 'jdn', ref, jdn, shadow, corrections, shown, base: (f) => jdn[f] ?? '' };
}

/** Writes a shadow's corrections back, refreshing its copy of the jdn listing; drops it if none are left. */
async function saveShadow(env, L, corrections, data, now) {
  if (!Object.keys(corrections).length) {
    if (L.shadow) await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(L.shadow.id).run();
    return;
  }
  const copy = { ...L.jdn };
  for (const f of Object.keys(corrections)) copy[f] = data[f];
  if (L.shadow) {
    await env.DB.prepare('UPDATE submissions SET data = ?, corrections = ?, reviewed_at = ? WHERE id = ?')
      .bind(JSON.stringify(copy), JSON.stringify(corrections), now, L.shadow.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO submissions (status, data, private, flags, created_at, shadows, corrections)
       VALUES ('published', ?, '{}', '[]', ?, ?, ?)`,
    ).bind(JSON.stringify(copy), now, L.ref, JSON.stringify(corrections)).run();
  }
}

/** Accepts one field's value into the listing. */
async function acceptValue(env, L, field, value, now) {
  if (L.kind === 'community') {
    const data = { ...parse(L.row.data, {}), [field]: value };
    const history = parse(L.row.corrections, {});
    history[field] = { previous: L.shown[field] ?? '', acceptedAt: now };
    await env.DB.prepare('UPDATE submissions SET data = ?, corrections = ? WHERE id = ?')
      .bind(JSON.stringify(data), JSON.stringify(history), L.row.id).run();
    await resetConfirmations(env, L.ref, L.row.id);
    return;
  }
  const corrections = { ...L.corrections, [field]: { base: L.base(field), acceptedAt: now } };
  const data = { ...(L.shadow ? parse(L.shadow.data, {}) : {}), [field]: value };
  await saveShadow(env, L, corrections, data, now);
}

/**
 * Before a listing is edited: drop corrections jdn has overtaken (jdn wins that
 * field), and mark stale any pending edit whose starting value is no longer
 * the listing's -- it can't be confirmed by edits made against the new one.
 */
async function retireOvertaken(env, L, now) {
  if (L.kind === 'jdn' && L.shadow) {
    const corrections = { ...L.corrections };
    for (const [f, c] of Object.entries(L.corrections)) {
      if (!sameValue(f, c.base, L.jdn[f] ?? '')) delete corrections[f];
    }
    if (Object.keys(corrections).length !== Object.keys(L.corrections).length) {
      await saveShadow(env, L, corrections, parse(L.shadow.data, {}), now);
    }
  }
  const { results: pending } = await env.DB.prepare(
    "SELECT edit_id, field, base FROM edit_fields WHERE restaurant = ? AND status = 'pending'",
  ).bind(L.ref).all();
  for (const row of pending) {
    if (!sameValue(row.field, row.base, L.base(row.field))) {
      await env.DB.prepare(
        "UPDATE edit_fields SET status = 'stale', decided_at = ? WHERE edit_id = ? AND field = ?",
      ).bind(now, row.edit_id, row.field).run();
    }
  }
}

// --- public ---------------------------------------------------------------

export async function submitEdit(request, env, cors) {
  const r = await intake(request, env, cors, 'edits', EDIT_FIELDS);
  if (r.response) return r.response;
  const { v, clientHash } = r;
  const now = r.now.toISOString();
  const ref = v.public.restaurant;

  let L;
  try {
    L = await listing(env, ref);
    if (L) {
      await retireOvertaken(env, L, now);
      L = await listing(env, ref); // as it stands after retiring
    }
  } catch (err) {
    console.error('listing', err);
    return json({ error: 'temporarily unavailable' }, 503, cors);
  }
  if (!L) return json({ error: 'invalid', fields: { restaurant: 'not_found' } }, 422, cors);

  const changes = EDITABLE
    .filter((k) => k in v.public && !sameValue(k, v.public[k], L.shown[k] ?? ''))
    .map((k) => ({ field: k, value: v.public[k], base: L.base(k) }));
  if (!changes.length) return json({ error: 'no changes' }, 422, cors);

  const flags = spamFlags(Object.fromEntries(changes.map((c) => [c.field, c.value])));

  const res = await env.DB.prepare(
    'INSERT INTO edits (restaurant, private, flags, created_at, client_hash) VALUES (?, ?, ?, ?, ?)',
  ).bind(ref, JSON.stringify(v.private), JSON.stringify(flags), now, clientHash).run();
  const editId = res.meta.last_row_id;
  for (const c of changes) {
    await env.DB.prepare(
      'INSERT INTO edit_fields (edit_id, restaurant, field, value, base) VALUES (?, ?, ?, ?, ?)',
    ).bind(editId, ref, c.field, c.value, c.base).run();
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
      ).bind(ref, c.field, editId, clientHash,
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
      await acceptValue(env, await listing(env, ref), c.field, agreeing[0].value, now);
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
 * Our corrections to jdn listings, for the build, from the published shadows:
 * { "2699": { "phone": { "value": "...", "base": "<jdn value it replaced>" } } }.
 * The build applies a value only while jdn's current value still matches
 * `base`. (Community listings carry their corrections in /api/published.)
 */
export async function publicVersions(env, cors) {
  const { results } = await env.DB.prepare(
    "SELECT shadows, data, corrections FROM submissions WHERE shadows IS NOT NULL AND status = 'published' ORDER BY shadows",
  ).all();
  const versions = {};
  for (const row of results) {
    const data = parse(row.data, {});
    for (const [f, c] of Object.entries(parse(row.corrections, {}))) {
      (versions[row.shadows] ??= {})[f] = { value: data[f], base: c.base, acceptedAt: c.acceptedAt };
    }
  }
  return json({ generated: new Date().toISOString(), versions }, 200,
    { ...cors, 'cache-control': 'public, max-age=300' });
}

// --- nightly ----------------------------------------------------------------

/**
 * Keeps every shadow in step with its jdn listing: refreshes the copy, drops
 * corrections jdn has overtaken (and the shadow, if none are left), holds a
 * shadow whose listing jdn removed, and releases it if the listing comes back.
 * Does nothing if jdn's data can't be read -- never hold everything on a blip.
 */
export async function syncShadows(env, now = new Date().toISOString()) {
  let records;
  try {
    records = await jdnRecords(env);
  } catch (err) {
    console.error('syncShadows: dataset unavailable', err?.message || err);
    return { skipped: true };
  }
  if (records.size < 100) return { skipped: true }; // a truncated dataset is not a mass removal

  const stats = { refreshed: 0, dropped: 0, held: 0, released: 0 };
  const { results } = await env.DB.prepare('SELECT * FROM submissions WHERE shadows IS NOT NULL').all();
  for (const row of results) {
    const flags = parse(row.flags, []);
    const rec = records.get(row.shadows);
    if (!rec) {
      if (row.status === 'published') {
        await env.DB.prepare("UPDATE submissions SET status = 'held', flags = ? WHERE id = ?")
          .bind(JSON.stringify([...flags, REMOVED_FLAG]), row.id).run();
        stats.held++;
      }
      continue;
    }
    const L = {
      kind: 'jdn', ref: row.shadows, jdn: asFields(rec), shadow: row,
      corrections: parse(row.corrections, {}),
    };
    const corrections = { ...L.corrections };
    for (const [f, c] of Object.entries(L.corrections)) {
      if (!sameValue(f, c.base, L.jdn[f] ?? '')) delete corrections[f];
    }
    const left = Object.keys(corrections).length;
    if (left) stats.refreshed++;
    else stats.dropped++;
    await saveShadow(env, L, corrections, parse(row.data, {}), now);
    // The listing is back on jdn: release a shadow that was held for its removal.
    if (left && row.status === 'held' && flags.some((f) => f.kind === REMOVED_FLAG.kind)) {
      await env.DB.prepare("UPDATE submissions SET status = 'published', flags = ? WHERE id = ?")
        .bind(JSON.stringify(flags.filter((f) => f.kind !== REMOVED_FLAG.kind)), row.id).run();
      stats.released++;
    }
  }
  return stats;
}

// --- admin ----------------------------------------------------------------

async function editView(env, row) {
  const { results } = await env.DB.prepare(
    'SELECT field, value, base, status, decided_by, decided_at FROM edit_fields WHERE edit_id = ? ORDER BY field',
  ).bind(row.id).all();
  return {
    id: row.id,
    restaurant: row.restaurant,
    flags: parse(row.flags, []),
    private: parse(row.private, {}),
    createdAt: row.created_at,
    reviewNote: row.review_note,
    fields: results.map((f) => ({
      field: f.field, value: f.value, base: f.base, status: f.status,
      decidedBy: f.decided_by, decidedAt: f.decided_at,
    })),
  };
}

/** /api/admin/edits[/:id], /api/admin/versions[/:restaurant[/:field]], /api/admin/sync. */
export async function adminEdits(request, env, url) {
  const p = url.pathname;

  if (p === '/api/admin/sync') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return json(await syncShadows(env));
  }

  // "versions": our corrections to jdn listings, i.e. what the shadows hold.
  let m = p.match(/^\/api\/admin\/versions(?:\/(\d+)(?:\/(\w+))?)?$/);
  if (m) {
    const [, restaurant, field] = m;
    if (request.method === 'GET' && !restaurant) {
      const { results } = await env.DB.prepare(
        'SELECT id, status, shadows, data, corrections FROM submissions WHERE shadows IS NOT NULL ORDER BY shadows',
      ).all();
      const versions = [];
      for (const row of results) {
        const data = parse(row.data, {});
        for (const [f, c] of Object.entries(parse(row.corrections, {}))) {
          versions.push({
            restaurant: row.shadows, shadow: `c${row.id}`, status: row.status,
            field: f, value: data[f], base: c.base, accepted_at: c.acceptedAt,
          });
        }
      }
      return json({ versions });
    }
    // The moderator corrects a jdn listing directly: { city: "...", ... }. Same
    // checks as any correction; it goes into the listing's shadow at once.
    if (request.method === 'POST' && restaurant && !field) {
      const body = await readBody(request);
      if (body.error) return json({ error: body.error }, body.status);
      const fields = EDIT_FIELDS.filter((f) => f.key !== 'restaurant' && EDITABLE.includes(f.key));
      const v = validate(body.value, fields);
      if (Object.keys(v.errors).length) return json({ error: 'invalid', fields: v.errors }, 422);
      const now = new Date().toISOString();
      let L;
      try {
        L = await listing(env, restaurant);
      } catch (err) {
        console.error('listing', err);
        return json({ error: 'dataset unavailable' }, 503);
      }
      if (!L) return json({ error: 'not found' }, 404);
      const applied = [];
      for (const [f, value] of Object.entries(v.public)) {
        if (sameValue(f, value, L.shown[f] ?? '')) continue;
        await acceptValue(env, await listing(env, restaurant), f, value, now);
        applied.push(f);
      }
      return json({ ok: true, restaurant, applied });
    }
    if (request.method === 'DELETE' && restaurant) {
      const shadow = await env.DB.prepare('SELECT * FROM submissions WHERE shadows = ?').bind(restaurant).first();
      if (!shadow) return json({ ok: true, removed: 0 });
      const corrections = parse(shadow.corrections, {});
      const data = parse(shadow.data, {});
      let removed = 0;
      for (const f of field ? [field] : Object.keys(corrections)) {
        if (!(f in corrections)) continue;
        data[f] = corrections[f].base; // jdn's value again, until the next sync refreshes the copy
        delete corrections[f];
        removed++;
      }
      if (!Object.keys(corrections).length) {
        await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(shadow.id).run();
      } else {
        await env.DB.prepare('UPDATE submissions SET data = ?, corrections = ? WHERE id = ?')
          .bind(JSON.stringify(data), JSON.stringify(corrections), shadow.id).run();
      }
      return json({ ok: true, removed });
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
  if (action === 'accept') {
    // The moderator's acceptance applies against the listing as it is now.
    try {
      if (!(await listing(env, row.restaurant))) return json({ error: 'restaurant no longer on the map' }, 409);
      for (const f of targets) {
        await acceptValue(env, await listing(env, row.restaurant), f.field, f.value, now);
      }
    } catch (err) {
      console.error('listing', err);
      return json({ error: 'dataset unavailable' }, 503);
    }
  }
  for (const f of targets) {
    await env.DB.prepare(
      `UPDATE edit_fields SET status = ?, decided_by = 'moderator', decided_at = ?
       WHERE edit_id = ? AND field = ?`,
    ).bind(action === 'accept' ? 'accepted' : 'rejected', now, id, f.field).run();
  }
  if (note !== null) {
    await env.DB.prepare('UPDATE edits SET review_note = ? WHERE id = ?').bind(String(note), id).run();
  }
  return json(await editView(env, await env.DB.prepare('SELECT * FROM edits WHERE id = ?').bind(id).first()));
}
