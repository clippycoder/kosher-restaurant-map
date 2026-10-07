/**
 * Community submissions API. A Cloudflare Worker over a D1 database, wholly
 * separate from the rest.jdn.co.il pipeline. It stores submissions, edits and
 * reports; geocoding happens later, in the site's build, like every other record.
 *
 *   GET    /api/health
 *   GET    /api/fields                 every form definition
 *   POST   /api/submissions            new restaurant -> published, or held if flagged
 *   POST   /api/edits                  change fields of a jdn restaurant (see edits.js)
 *   POST   /api/reports                "closed / wrong info" on any restaurant
 *   GET    /api/published              published submissions, public fields only
 *   GET    /api/versions               our accepted field values for jdn restaurants
 *
 *   GET    /api/admin/submissions?status=held|published|rejected|all&limit=&before=
 *   GET    /api/admin/submissions/:id
 *   POST   /api/admin/submissions/:id  { action: publish|reject, note?, edits? }
 *   DELETE /api/admin/submissions/:id
 *   GET    /api/admin/edits?status=pending|all
 *   GET    /api/admin/edits/:id
 *   POST   /api/admin/edits/:id        { action: accept|reject, fields?, note? }
 *   DELETE /api/admin/edits/:id
 *   GET    /api/admin/versions
 *   DELETE /api/admin/versions/:restaurant[/:field]
 *   GET    /api/admin/reports?status=open|resolved|dismissed|all&limit=&before=
 *   GET    /api/admin/reports/:id
 *   POST   /api/admin/reports/:id      { action: resolve|dismiss|reopen, note? }
 *   DELETE /api/admin/reports/:id
 *
 * Admin routes need `Authorization: Bearer <ADMIN_TOKEN>`. Every secret is
 * required: with one missing, the affected routes refuse rather than run open.
 */

import { validate, publicSpec, FIELDS, REPORT_FIELDS } from '../../public/forms/fields.js';
import { spamFlags, duplicateFlags } from './screen.js';
import { jdnRecords } from './dataset.js';
import { intake, purgeClientHashes } from './intake.js';
import { submitEdit, publicVersions, adminEdits, syncShadows, REMOVED_FLAG } from './edits.js';
import { json, corsHeaders, readBody, requireAdmin } from './http.js';

export { purgeClientHashes };

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error(err?.stack || err);
      return json({ error: 'internal' }, 500, corsHeaders(request, env) || {});
    }
  },

  // Nightly: forget submitter fingerprints older than 30 days, and bring every
  // shadow listing into step with its jdn listing.
  async scheduled(_event, env) {
    await purgeClientHashes(env);
    console.log('syncShadows', JSON.stringify(await syncShadows(env)));
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;

  if (p.startsWith('/api/admin/')) {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    if (/^\/api\/admin\/(edits|versions|sync)(\/|$)/.test(p)) return adminEdits(request, env, url);
    return admin(request, env, url);
  }

  const cors = corsHeaders(request, env);
  if (cors === null) return json({ error: 'origin not allowed' }, 403);
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (method === 'GET' && p === '/api/health') return json({ ok: true }, 200, cors);
  if (method === 'GET' && p === '/api/fields') {
    return json(publicSpec(), 200, { ...cors, 'cache-control': 'public, max-age=300' });
  }
  if (method === 'GET' && p === '/api/published') return published(env, cors);
  if (method === 'GET' && p === '/api/versions') return publicVersions(env, cors);
  if (method === 'POST' && p === '/api/submissions') return submit(request, env, cors);
  if (method === 'POST' && p === '/api/edits') return submitEdit(request, env, cors);
  if (method === 'POST' && p === '/api/reports') return report(request, env, cors);

  return json({ error: 'not found' }, 404, cors);
}

// --- public ---------------------------------------------------------------

async function submit(request, env, cors) {
  const r = await intake(request, env, cors, 'submissions', FIELDS);
  if (r.response) return r.response;
  const { v, clientHash, now } = r;

  const flags = [...spamFlags(v.public), ...duplicateFlags(v.public, await existing(env))];
  const status = flags.length ? 'held' : 'published';

  const res = await env.DB.prepare(
    `INSERT INTO submissions (status, data, private, flags, created_at, client_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(status, JSON.stringify(v.public), JSON.stringify(v.private), JSON.stringify(flags),
    now.toISOString(), clientHash).run();

  // The submitter learns whether it waits for review, not why.
  return json({ ok: true, id: `c${res.meta.last_row_id}`, status }, 201, cors);
}

async function report(request, env, cors) {
  const r = await intake(request, env, cors, 'reports', REPORT_FIELDS);
  if (r.response) return r.response;
  const { v, clientHash, now } = r;

  const res = await env.DB.prepare(
    `INSERT INTO reports (restaurant, kind, details, created_at, client_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(v.public.restaurant, v.public.kind, v.public.details ?? null,
    now.toISOString(), clientHash).run();

  return json({ ok: true, id: res.meta.last_row_id }, 201, cors);
}

async function published(env, cors) {
  // Selects `data` only. `private` never leaves the database on this path.
  // Our own listings only: shadows reach the map through /api/versions.
  const { results } = await env.DB.prepare(
    "SELECT id, data, created_at FROM submissions WHERE status = 'published' AND shadows IS NULL ORDER BY id",
  ).all();
  return json({
    generated: new Date().toISOString(),
    submissions: results.map((row) => ({
      id: `c${row.id}`, ...JSON.parse(row.data), submittedAt: row.created_at,
    })),
  }, 200, { ...cors, 'cache-control': 'public, max-age=300' });
}

/** Everything a new submission could duplicate: the live map plus our own rows. */
async function existing(env) {
  const out = [];
  try {
    for (const r of (await jdnRecords(env)).values()) {
      out.push({ source: 'jdn', id: String(r.id), name: r.name, city: r.city, phone: r.phone });
    }
  } catch (err) {
    // Don't hold every submission because Pages blinked; ours are still checked.
    console.error('dataset fetch failed', err);
  }
  // Shadows duplicate a jdn listing by design; they are not new restaurants.
  const { results } = await env.DB.prepare(
    "SELECT id, data FROM submissions WHERE status IN ('published', 'held') AND shadows IS NULL",
  ).all();
  for (const row of results) {
    const d = JSON.parse(row.data);
    out.push({ source: 'community', id: `c${row.id}`, name: d.name, city: d.city, phone: d.phone });
  }
  return out;
}

// --- admin: submissions and reports ---------------------------------------

const COLLECTIONS = {
  submissions: {
    statuses: ['published', 'held', 'rejected'],
    defaultStatus: 'held',
    actions: { publish: 'published', reject: 'rejected' },
    view: (r) => ({
      id: r.id, ref: `c${r.id}`, status: r.status, shadows: r.shadows ?? null,
      data: JSON.parse(r.data), private: JSON.parse(r.private), flags: JSON.parse(r.flags),
      corrections: JSON.parse(r.corrections || '{}'),
      createdAt: r.created_at, reviewedAt: r.reviewed_at, reviewNote: r.review_note,
    }),
  },
  reports: {
    statuses: ['open', 'resolved', 'dismissed'],
    defaultStatus: 'open',
    actions: { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open' },
    view: (r) => ({
      id: r.id, status: r.status, restaurant: r.restaurant, kind: r.kind, details: r.details,
      createdAt: r.created_at, reviewedAt: r.reviewed_at, reviewNote: r.review_note,
    }),
  },
};

async function admin(request, env, url) {
  const m = url.pathname.match(/^\/api\/admin\/(submissions|reports)(?:\/(\d+))?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const table = m[1];
  const c = COLLECTIONS[table];
  const id = m[2] ? Number(m[2]) : null;

  if (id === null) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const status = url.searchParams.get('status') || c.defaultStatus;
    if (status !== 'all' && !c.statuses.includes(status)) return json({ error: 'bad status' }, 400);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE (? = 'all' OR status = ?) AND id < ? ORDER BY id DESC LIMIT ?`,
    ).bind(status, status, before, limit).all();
    return json({ [table]: results.map(c.view) });
  }

  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);

  if (request.method === 'GET') return json(c.view(row));

  if (request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return json({ ok: true, deleted: id });
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, body.status);
  const { action, note = null, edits = null } = body.value;
  const status = c.actions[action];
  if (!status) return json({ error: `action must be one of: ${Object.keys(c.actions).join(', ')}` }, 400);

  const sets = { status, reviewed_at: new Date().toISOString(), review_note: note === null ? null : String(note) };

  // The moderator may correct a submission while reviewing it. The merged
  // record goes through the same validation as a fresh one.
  if (table === 'submissions' && edits && typeof edits === 'object') {
    const v = validate({ ...JSON.parse(row.data), ...JSON.parse(row.private), ...edits });
    if (Object.keys(v.errors).length) return json({ error: 'invalid', fields: v.errors }, 422);
    sets.data = JSON.stringify(v.public);
    sets.private = JSON.stringify(v.private);
  }

  // Publishing a shadow held because jdn removed its listing keeps it as a
  // listing of our own: it stops shadowing and carries its full copy.
  if (table === 'submissions' && status === 'published' && row.shadows &&
      JSON.parse(row.flags).some((f) => f.kind === REMOVED_FLAG.kind)) {
    sets.shadows = null;
    sets.corrections = '{}';
    sets.flags = JSON.stringify(JSON.parse(row.flags).filter((f) => f.kind !== REMOVED_FLAG.kind));
  }

  const cols = Object.keys(sets);
  await env.DB.prepare(
    `UPDATE ${table} SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
  ).bind(...cols.map((k) => sets[k]), id).run();
  const updated = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  return json(c.view(updated));
}
