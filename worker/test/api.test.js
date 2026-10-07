import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { purgeClientHashes } from '../src/index.js';
import { normalizePhone } from '../../public/forms/fields.js';
import { spamFlags, dupKey } from '../src/screen.js';
import { createD1 } from './d1.js';
import { resetDatasetCache } from '../src/dataset.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ORIGIN = 'https://clippycoder.github.io';
const DATASET_URL = 'https://example.test/restaurants.json';

// The live map, as the worker sees it. Rebuilt per test, since edit tests change it.
const freshDataset = () => ({
  restaurants: [
    { id: 2699, name: 'מסעדת שף קבלרו', address: 'המרפא 1', city: 'ירושלים', type: 'בשרי',
      kashrut: 'בד״ץ העדה״ח ירושלים', phone: '02-53-770-00', modified: '2026-09-01T00:00:00' },
    { id: 100, name: 'פיצה שמש', address: 'הרצל 1', city: 'קריית אונו', type: 'חלבי',
      kashrut: 'בית יוסף', phone: '03-1234567', modified: '2026-09-01T00:00:00' },
  ],
});
let DATASET;

let env;
let turnstileCalls;

beforeEach(() => {
  DATASET = freshDataset();
  resetDatasetCache();
  env = {
    DB: createD1(MIGRATIONS),
    ADMIN_TOKEN: 'secret-admin',
    TURNSTILE_SECRET: 'ts-secret',
    TURNSTILE_HOSTNAMES: 'clippycoder.github.io',
    RATE_SALT: 'salt',
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8080`,
    DATASET_URL,
  };
  turnstileCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('turnstile')) {
      turnstileCalls++;
      // Tokens name what siteverify should say about them:
      //   ok / ok-edit / ok-report     solved on the site, for that form's action
      //   wrong-host, wrong-action     solved, but not here / not for this form
      //   test-key                     Cloudflare's test keys: example.com, no action
      const token = new URLSearchParams(init.body.toString()).get('response');
      const solved = { success: true, hostname: 'clippycoder.github.io', 'error-codes': [] };
      const answers = {
        ok: { ...solved, action: 'add' },
        'ok-edit': { ...solved, action: 'edit' },
        'ok-report': { ...solved, action: 'report' },
        'wrong-host': { ...solved, action: 'add', hostname: 'evil.test' },
        'wrong-action': { ...solved, action: 'report' },
        'test-key': { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } },
      };
      return Response.json(answers[token] || { success: false, 'error-codes': ['invalid-input-response'] });
    }
    if (url === DATASET_URL) return Response.json(DATASET);
    throw new Error(`unexpected fetch ${url}`);
  };
});

const VALID = {
  name: 'בורגר בר',
  address: 'יפו 50',
  city: 'ירושלים',
  type: 'בשרי',
  hechsher: 'רבנות מהדרין',
  phone: '02-555-1234',
  'cf-turnstile-response': 'ok',
};

async function call(method, p, { body, origin = ORIGIN, admin = false, ip = '1.2.3.4', form = false } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (admin) headers.Authorization = `Bearer ${admin === true ? env.ADMIN_TOKEN : admin}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`https://api.test${p}`, { method, headers, body: payload }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const submit = (body, opts) => call('POST', '/api/submissions', { body, ...opts });

// --- submissions ------------------------------------------------------------

test('a clean submission publishes immediately and appears in /api/published', async () => {
  const r = await submit(VALID);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true, id: 'c1', status: 'published' });

  const pub = await call('GET', '/api/published');
  assert.equal(pub.body.submissions.length, 1);
  assert.equal(pub.body.submissions[0].id, 'c1');
  assert.equal(pub.body.submissions[0].name, 'בורגר בר');
  assert.equal(pub.body.submissions[0].phone, '025551234');
});

test('private fields are stored but never published', async () => {
  await submit({ ...VALID, ownerPhone: '054-1234567', submitterRole: 'בעלים / צוות' });
  const pub = await call('GET', '/api/published');
  const raw = JSON.stringify(pub.body);
  assert.ok(!raw.includes('0541234567'));
  assert.ok(!raw.includes('ownerPhone'));
  assert.ok(!raw.includes('submitterRole'));

  const adm = await call('GET', '/api/admin/submissions/1', { admin: true, origin: null });
  assert.equal(adm.body.private.ownerPhone, '0541234567');
  assert.equal(adm.body.private.submitterRole, 'בעלים / צוות');
});

test('missing required fields are rejected with per-field errors, without spending the captcha', async () => {
  const r = await submit({ name: 'x', 'cf-turnstile-response': 'ok' });
  assert.equal(r.status, 422);
  for (const k of ['address', 'city', 'type', 'hechsher', 'phone']) assert.ok(r.body.fields[k], k);
  assert.equal(turnstileCalls, 0);
});

test('a malformed phone is refused outright with a hint, not held', async () => {
  const r = await submit({ ...VALID, phone: '050-56800688' });
  assert.equal(r.status, 422);
  assert.equal(r.body.fields.phone, 'bad_phone');
  const w = await submit({ ...VALID, whatsapp: '08-923-220' });
  assert.equal(w.status, 422, 'optional phones are checked too');
  const adm = await call('GET', '/api/admin/submissions?status=all', { admin: true, origin: null });
  assert.equal(adm.body.submissions.length, 0);
});

test('optional fields stay optional; bad values in them are still rejected', async () => {
  assert.equal((await submit({ ...VALID, delivery: 'אולי' })).status, 422);
  assert.equal((await submit({ ...VALID, hechsher: 'אחר' })).status, 422, 'hechsher is jdn\'s list only');
  assert.equal((await submit({ ...VALID, website: 'javascript:alert(1)' })).status, 422);
  const ok = await submit({ ...VALID, website: '@burgerbar', delivery: 'כן', hours: 'א-ה 12:00-23:00' });
  assert.equal(ok.status, 201);
  const pub = await call('GET', '/api/published');
  assert.equal(pub.body.submissions[0].website, 'https://instagram.com/burgerbar');
});

test('unknown keys are dropped, not stored', async () => {
  await submit({ ...VALID, isAdmin: true, status: 'published', coupon: 'FREE' });
  const adm = await call('GET', '/api/admin/submissions/1', { admin: true, origin: null });
  assert.ok(!('isAdmin' in adm.body.data));
  assert.ok(!('coupon' in adm.body.data));
});

test('form-encoded posts work as well as JSON', async () => {
  assert.equal((await submit(VALID, { form: true })).status, 201);
});

test('a failed captcha is refused and nothing is stored', async () => {
  const r = await submit({ ...VALID, 'cf-turnstile-response': 'bad' });
  assert.equal(r.status, 403);
  const adm = await call('GET', '/api/admin/submissions?status=all', { admin: true, origin: null });
  assert.equal(adm.body.submissions.length, 0);
});

test('the honeypot fakes success and stores nothing', async () => {
  const r = await submit({ ...VALID, company: 'Spam Inc' });
  assert.equal(r.status, 201);
  const adm = await call('GET', '/api/admin/submissions?status=all', { admin: true, origin: null });
  assert.equal(adm.body.submissions.length, 0);
});

test('spam in a required field is held, with the reason recorded', async () => {
  const r = await submit({ ...VALID, name: 'Best casino www.win.com' });
  assert.equal(r.body.status, 'held');
  const adm = await call('GET', '/api/admin/submissions/1', { admin: true, origin: null });
  const reasons = adm.body.flags.map((f) => f.reason);
  assert.ok(reasons.includes('link'));
  assert.ok(reasons.includes('spam word'));
  assert.equal((await call('GET', '/api/published')).body.submissions.length, 0);
});

test('spam in an optional field does not hold; a foreign phone does not hold', async () => {
  const r = await submit({ ...VALID, description: 'visit www.example.com', phone: '+1 212 555 0100' });
  assert.equal(r.body.status, 'published');
});

test('a duplicate of a jdn restaurant is held', async () => {
  const r = await submit({ ...VALID, name: 'שף קבלרו', city: 'ירושלים' });
  assert.equal(r.body.status, 'held');
  const adm = await call('GET', '/api/admin/submissions/1', { admin: true, origin: null });
  assert.equal(adm.body.flags[0].kind, 'duplicate');
  assert.equal(adm.body.flags[0].source, 'jdn');
  assert.equal(adm.body.flags[0].id, '2699');
});

test('city spelling variants still count as the same city for duplicates', async () => {
  const r = await submit({ ...VALID, name: 'פיצה שמש', city: 'קרית אונו', phone: '03-9999999' });
  assert.equal(r.body.status, 'held');
});

test('the same phone as an existing restaurant is held as a likely duplicate', async () => {
  const r = await submit({ ...VALID, name: 'שם אחר לגמרי', phone: '025377000' });
  assert.equal(r.body.status, 'held');
});

test('a second submission of our own published entry is held', async () => {
  await submit(VALID);
  const r = await submit({ ...VALID, phone: '02-666-0000' }, { ip: '9.9.9.9' });
  assert.equal(r.body.status, 'held');
});

test('the duplicate check survives the dataset being unreachable', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === DATASET_URL) throw new Error('down');
    return orig(url, init);
  };
  const r = await submit({ ...VALID, name: 'שף קבלרו' });
  assert.equal(r.body.status, 'published');
});

test('rate limit: five per person per day, other people unaffected', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await submit({ ...VALID, name: `מסעדה ${'אבגדה'[i]}`, phone: `02-555-000${i}` });
    assert.equal(r.status, 201);
  }
  assert.equal((await submit({ ...VALID, name: 'עוד אחת' })).status, 429);
  assert.equal((await submit({ ...VALID, name: 'מישהו אחר' }, { ip: '5.6.7.8' })).status, 201);
});

test('submitter fingerprints are kept 30 days, then purged; records are kept', async () => {
  await submit(VALID);
  await purgeClientHashes(env, Date.now() + 29 * 24 * 3600 * 1000);
  assert.ok(env.DB.raw.prepare('SELECT client_hash FROM submissions').get().client_hash);
  await purgeClientHashes(env, Date.now() + 31 * 24 * 3600 * 1000);
  const row = env.DB.raw.prepare('SELECT client_hash, data FROM submissions').get();
  assert.equal(row.client_hash, null);
  assert.ok(row.data);
});

test('the fingerprint is a hash, not the IP, and is stable for one person across days', async () => {
  await submit(VALID);
  await submit({ ...VALID, name: 'מקום אחר', phone: '02-777-7777' });
  const rows = env.DB.raw.prepare('SELECT client_hash FROM submissions').all();
  assert.match(rows[0].client_hash, /^[0-9a-f]{64}$/);
  assert.ok(!rows[0].client_hash.includes('1.2.3.4'));
  assert.equal(rows[0].client_hash, rows[1].client_hash);
});

test('missing secrets make submissions refuse rather than run open', async () => {
  delete env.TURNSTILE_SECRET;
  assert.equal((await submit(VALID)).status, 503);
});

// --- CORS -------------------------------------------------------------------

test('CORS: allowed origin gets headers, other sites are refused, no-origin is allowed', async () => {
  const ok = await call('GET', '/api/fields');
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await call('POST', '/api/submissions', { body: VALID, origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('GET', '/api/published', { origin: null })).status, 200);
  const pre = await call('OPTIONS', '/api/submissions');
  assert.equal(pre.status, 204);
});

test('oversized and malformed bodies are refused', async () => {
  assert.equal((await submit({ ...VALID, description: 'א'.repeat(40_000) })).status, 413);
  const res = await worker.fetch(new Request('https://api.test/api/submissions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
  }), env);
  assert.equal(res.status, 400);
});

// --- reports ----------------------------------------------------------------

test('reports: stored for review, details required only for details/other', async () => {
  const send = (body) => call('POST', '/api/reports', { body: { 'cf-turnstile-response': 'ok-report', ...body } });
  assert.equal((await send({ restaurant: '2699', kind: 'closed' })).status, 201);
  assert.equal((await send({ restaurant: 'c3', kind: 'location' })).status, 201);
  assert.equal((await send({ restaurant: '2699', kind: 'details' })).status, 422);
  assert.equal((await send({ restaurant: '2699', kind: 'details', details: 'הטלפון השתנה' })).status, 201);
  assert.equal((await send({ restaurant: '<script>', kind: 'closed' })).status, 422);
  assert.equal((await send({ restaurant: '2699', kind: 'bogus' })).status, 422);

  const open = await call('GET', '/api/admin/reports', { admin: true, origin: null });
  assert.equal(open.body.reports.length, 3);

  const done = await call('POST', '/api/admin/reports/1', { admin: true, origin: null, body: { action: 'resolve', note: 'hidden' } });
  assert.equal(done.body.status, 'resolved');
  assert.equal((await call('GET', '/api/admin/reports', { admin: true, origin: null })).body.reports.length, 2);
});

// --- admin ------------------------------------------------------------------

test('admin requires the token', async () => {
  assert.equal((await call('GET', '/api/admin/submissions', { origin: null })).status, 401);
  assert.equal((await call('GET', '/api/admin/submissions', { origin: null, admin: 'wrong' })).status, 401);
  delete env.ADMIN_TOKEN;
  assert.equal((await call('GET', '/api/admin/submissions', { origin: null, admin: 'x' })).status, 503);
});

test('admin: publish a held entry with a correction, then reject, then delete', async () => {
  await submit({ ...VALID, name: 'Burger www.burger.com' });
  const fix = await call('POST', '/api/admin/submissions/1', {
    admin: true, origin: null, body: { action: 'publish', edits: { name: 'Burger Bar' }, note: 'stripped link' },
  });
  assert.equal(fix.body.status, 'published');
  assert.equal(fix.body.data.name, 'Burger Bar');
  assert.equal((await call('GET', '/api/published')).body.submissions[0].name, 'Burger Bar');

  const bad = await call('POST', '/api/admin/submissions/1', {
    admin: true, origin: null, body: { action: 'publish', edits: { type: 'nope' } },
  });
  assert.equal(bad.status, 422);

  await call('POST', '/api/admin/submissions/1', { admin: true, origin: null, body: { action: 'reject' } });
  assert.equal((await call('GET', '/api/published')).body.submissions.length, 0);

  assert.equal((await call('DELETE', '/api/admin/submissions/1', { admin: true, origin: null })).status, 200);
  assert.equal((await call('GET', '/api/admin/submissions/1', { admin: true, origin: null })).status, 404);
});

// --- units ------------------------------------------------------------------

test('phone normalisation', () => {
  assert.equal(normalizePhone('02-53-770-00'), '025377000');
  assert.equal(normalizePhone('+972 54-123-4567'), '0541234567');
  assert.equal(normalizePhone('00972-3-1234567'), '031234567');
  assert.equal(normalizePhone('1-800-123-456'), '1800123456');
  assert.equal(normalizePhone('*2345'), '*2345');
  assert.equal(normalizePhone('+1 (212) 555-0100'), '+12125550100');
  assert.equal(normalizePhone('2242*'), '*2242', 'star typed after the digits, as RTL puts it');
  assert.equal(normalizePhone('077-7000333 שלוחה 6'), '0777000333 שלוחה 6');
  assert.equal(normalizePhone('0777000333 שלוחה 6'), '0777000333 שלוחה 6', 'idempotent');
  assert.equal(normalizePhone('054 123 4567 ext 12'), '0541234567 שלוחה 12');
  // jdn's four real typos
  for (const typo of ['050-56800688', '08-923-220', '170506070', '08-661-880']) {
    assert.equal(normalizePhone(typo), null, typo);
  }
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('call me'), null);
});

test('spam rules leave ordinary Hebrew and English names alone', () => {
  for (const name of ['בורגר בר', "Joe's Pizza", 'שניצל & צ׳יפס', 'קפה 2000', 'Schnitzel Express', 'סושי 🍣']) {
    assert.deepEqual(spamFlags({ name, address: 'יפו 50', city: 'ירושלים' }), [], name);
  }
  assert.ok(spamFlags({ name: 'aaaaaaa', address: 'x 1', city: 'ירושלים' }).length);
  assert.ok(spamFlags({ name: 'qwrtzxvb', address: 'x 1', city: 'ירושלים' }).length);
  assert.ok(spamFlags({ name: '!!!', address: 'x 1', city: 'ירושלים' }).length);
  assert.ok(spamFlags({ name: 'مطعم', address: 'x 1', city: 'ירושלים' }).length, 'Arabic is held');
  assert.ok(spamFlags({ name: 'Ελληνικό', address: 'x 1', city: 'ירושלים' }).length, 'Greek is held');
});

test('Chinese, Japanese, Korean and Cyrillic names are allowed', () => {
  for (const name of ['寿司 Sushi', 'すし屋', 'ラーメン', '김치 하우스', 'Ресторан Пушкин']) {
    assert.deepEqual(spamFlags({ name, address: 'יפו 50', city: 'ירושלים' }), [], name);
  }
});

test('listed words match whole words only', () => {
  const reasons = (name) => spamFlags({ name }).map((f) => f.reason);
  assert.deepEqual(reasons('Best Casino'), ['spam word']);
  assert.deepEqual(reasons('נערות ליווי בתל אביב'), ['spam word']);
  assert.deepEqual(reasons('פיצה זונה'), ['offensive word']);
  for (const ok of ['Essex Grill', 'Sexton Deli', 'Cocktail Bar', 'בית מזונות', 'כוס קפה', 'ליווי מוזיקלי']) {
    assert.deepEqual(reasons(ok), [], ok);
  }
});

test('address rules: the name, the city, or both are not an address', () => {
  const reasons = (address) => spamFlags({ name: 'בורגר בר', address, city: 'ירושלים' }).map((f) => f.reason);
  assert.deepEqual(reasons('בורגר בר'), ['address is the name']);
  assert.deepEqual(reasons('ירושלים'), ['address is only the city']);
  assert.deepEqual(reasons('בורגר בר, ירושלים'), ['address is the name and city']);
  assert.deepEqual(reasons('קניון מלחה'), [], 'a landmark without a number is fine');
  assert.deepEqual(reasons('בורגר בר, יפו 50, ירושלים'), [], 'the name inside a real address is fine');
});

test('dupKey folds the usual spelling variants', () => {
  assert.equal(dupKey('קרית אונו'), dupKey('קריית-אונו'));
  assert.equal(dupKey('מסעדת שף קבלרו'), dupKey('שף קבלרו'));
  assert.equal(dupKey('ג׳וז'), dupKey("ג'וז"));
});

test('a chain\'s shared national number is not treated as a duplicate', async () => {
  DATASET.restaurants.push({ id: 7, name: 'פיצה האט – אשדוד', city: 'אשדוד', phone: '1700506070' });
  try {
    const r = await submit({ ...VALID, name: 'פיצה האט – חיפה', city: 'חיפה', phone: '1-700-50-60-70' });
    assert.equal(r.body.status, 'published');
  } finally {
    DATASET.restaurants.pop();
  }
});

test('invisible direction marks are stripped before screening and storage', async () => {
  const r = await submit({ ...VALID, address: '‫שייקה אופיר 1‬' });
  assert.equal(r.body.status, 'published');
  const pub = await call('GET', '/api/published');
  assert.equal(pub.body.submissions[0].address, 'שייקה אופיר 1');
});

// --- edits of jdn restaurants -------------------------------------------------

// Each edit arrives two hours after the ones before it (by backdating those),
// unless `soon` -- so "two people" tests aren't tripped by the one-hour gap.
function edit(body, ip = '1.1.1.1', { soon = false } = {}) {
  if (!soon) {
    env.DB.raw.prepare("UPDATE edits SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-2 hours')").run();
  }
  return call('POST', '/api/edits', { body: { 'cf-turnstile-response': 'ok-edit', restaurant: '2699', ...body }, ip });
}
const versions = async () => (await call('GET', '/api/versions')).body.versions;

test('edits: a single edit is pending and changes nothing', async () => {
  const r = await edit({ phone: '02-999-9999' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.accepted, []);
  assert.deepEqual(r.body.pending, ['phone']);
  assert.deepEqual(await versions(), {});
});

test('edits: two people with the same value -> accepted immediately, formatting ignored', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  const r = await edit({ phone: '029999999' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, ['phone']);
  const v = await versions();
  assert.equal(v['2699'].phone.value, '029999999');
  assert.equal(v['2699'].phone.base, '02-53-770-00', 'remembers the jdn value it replaced');
  const first = await call('GET', '/api/admin/edits/1', { admin: true, origin: null });
  assert.equal(first.body.fields[0].status, 'accepted');
  assert.equal(first.body.fields[0].decidedBy, 'corroborated');
});

test('edits: two people within the hour do not confirm each other; a third, later, does', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  const r2 = await edit({ phone: '02-999-9999' }, '2.2.2.2', { soon: true });
  assert.deepEqual(r2.body.accepted, [], 'wifi then mobile data, minutes apart, is one person');
  const r3 = await edit({ phone: '02-999-9999' }, '3.3.3.3');
  assert.deepEqual(r3.body.accepted, ['phone']);
});

test('edits: the same person twice does not count as two', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  const r = await edit({ phone: '02-999-9999' }, '1.1.1.1');
  assert.deepEqual(r.body.accepted, []);
  assert.deepEqual(await versions(), {});
});

test('edits: matched field by field', async () => {
  await edit({ phone: '02-999-9999', hours: 'א-ה 12-22' }, '1.1.1.1');
  const r = await edit({ phone: '02-999-9999', name: 'שף קבלרו החדש' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, ['phone']);
  assert.deepEqual(r.body.pending.sort(), ['name']);
  const v = await versions();
  assert.deepEqual(Object.keys(v['2699']), ['phone']);
  // a third person confirms the hours
  const r3 = await edit({ hours: 'א־ה 12–22' }, '3.3.3.3');
  assert.deepEqual(r3.body.accepted, ['hours'], 'punctuation and dash style ignored');
});

test('edits: disagreeing values both stay pending', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  const r = await edit({ phone: '02-888-8888' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, []);
  const pending = await call('GET', '/api/admin/edits', { admin: true, origin: null });
  assert.equal(pending.body.edits.length, 2);
});

test('edits: no-op edits are refused', async () => {
  assert.equal((await edit({ phone: '025377000' })).status, 422, 'same as jdn');
  assert.equal((await edit({})).status, 422, 'nothing at all');
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  await edit({ phone: '02-999-9999' }, '2.2.2.2');
  const r = await edit({ phone: '02-999-9999' }, '3.3.3.3');
  assert.equal(r.status, 422, 'same as our accepted version');
});

test('edits: only jdn restaurants on the map can be edited', async () => {
  assert.equal((await edit({ restaurant: '424242', phone: '02-999-9999' })).status, 422);
  assert.equal((await edit({ restaurant: 'c1', phone: '02-999-9999' })).status, 422);
});

test('edits: a flagged edit neither confirms nor is confirmed', async () => {
  await edit({ name: 'cheap casino www.x.com' }, '1.1.1.1');
  const r = await edit({ name: 'cheap casino www.x.com' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, []);
  assert.deepEqual(await versions(), {});
});

test('edits: when jdn changes a field, only that field of our version is dropped', async () => {
  for (const ip of ['1.1.1.1', '2.2.2.2']) await edit({ phone: '02-999-9999', hours: '12-22' }, ip);
  assert.deepEqual(Object.keys(await versions()).length, 1);

  // jdn updates the phone, not the hours
  DATASET.restaurants[0].phone = '02-111-2222';
  DATASET.restaurants[0].modified = '2026-10-01T00:00:00';
  resetDatasetCache();

  // retirement happens on the next edit of that restaurant (the build also checks `base`)
  await edit({ description: 'מסעדת בשרים' }, '3.3.3.3');
  const v = await versions();
  assert.ok(!('phone' in v['2699']), 'jdn changed the phone: theirs wins');
  assert.equal(v['2699'].hours.value, '12-22', 'jdn did not touch the hours: ours stays');
});

test('edits: a pending edit made against an old jdn value cannot be confirmed by one against the new', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  DATASET.restaurants[0].phone = '02-111-2222';
  resetDatasetCache();
  const r = await edit({ phone: '02-999-9999' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, []);
  const first = await call('GET', '/api/admin/edits/1', { admin: true, origin: null });
  assert.equal(first.body.fields[0].status, 'stale');
});

test('edits: corroboration needs the first fingerprint, so it lapses after 30 days', async () => {
  await edit({ phone: '02-999-9999' }, '1.1.1.1');
  await purgeClientHashes(env, Date.now() + 31 * 24 * 3600 * 1000);
  const r = await edit({ phone: '02-999-9999' }, '2.2.2.2');
  assert.deepEqual(r.body.accepted, []);
});

test('edits: private fields in an edit stay private', async () => {
  await edit({ phone: '02-999-9999', ownerPhone: '054-7654321', submitterRole: 'לקוח' });
  const raw = JSON.stringify(await call('GET', '/api/versions'));
  assert.ok(!raw.includes('0547654321'));
  const adm = await call('GET', '/api/admin/edits/1', { admin: true, origin: null });
  assert.equal(adm.body.private.ownerPhone, '0547654321');
  assert.deepEqual(adm.body.fields.map((f) => f.field), ['phone'], 'private fields are not field changes');
});

test('edits admin: accept some fields, reject the rest, remove a version', async () => {
  await edit({ phone: '02-999-9999', hours: '12-22', name: 'שם חדש' });
  const a = await call('POST', '/api/admin/edits/1', {
    admin: true, origin: null, body: { action: 'accept', fields: ['phone', 'hours'] },
  });
  assert.deepEqual(a.body.fields.map((f) => `${f.field}:${f.status}`).sort(),
    ['hours:accepted', 'name:pending', 'phone:accepted']);
  await call('POST', '/api/admin/edits/1', { admin: true, origin: null, body: { action: 'reject' } });
  const after = await call('GET', '/api/admin/edits/1', { admin: true, origin: null });
  assert.equal(after.body.fields.find((f) => f.field === 'name').status, 'rejected');
  assert.equal((await call('GET', '/api/admin/edits', { admin: true, origin: null })).body.edits.length, 0);

  assert.deepEqual(Object.keys((await versions())['2699']).sort(), ['hours', 'phone']);
  await call('DELETE', '/api/admin/versions/2699/phone', { admin: true, origin: null });
  assert.deepEqual(Object.keys((await versions())['2699']), ['hours']);
  await call('DELETE', '/api/admin/versions/2699', { admin: true, origin: null });
  assert.deepEqual(await versions(), {});
});

test('edits admin requires the token', async () => {
  assert.equal((await call('GET', '/api/admin/edits', { origin: null })).status, 401);
  assert.equal((await call('DELETE', '/api/admin/versions/2699', { origin: null })).status, 401);
});

test('the add form\'s advanced section offers בהשגחה\'s own form, with the approval caveat', async () => {
  const spec = (await call('GET', '/api/fields')).body;
  const adv = spec.submissionSections.advanced;
  assert.equal(adv.collapsed, true);
  assert.equal(adv.note.link.href, 'https://rest.jdn.co.il/add-res-2/');
  assert.match(adv.note.text, /אישור/);
  assert.match(adv.note.text, /זמן/);
  // every field's section has a definition
  for (const f of spec.submission) assert.ok(spec.submissionSections[f.section], f.key);
});

// --- captcha (canonical siteverify) -------------------------------------------

test('captcha: a token solved on another site is refused', async () => {
  assert.equal((await submit({ ...VALID, 'cf-turnstile-response': 'wrong-host' })).status, 403);
});

test('captcha: a token from another form (action) is refused', async () => {
  assert.equal((await submit({ ...VALID, 'cf-turnstile-response': 'wrong-action' })).status, 403);
  const r = await call('POST', '/api/reports', {
    body: { 'cf-turnstile-response': 'ok', restaurant: '2699', kind: 'closed' },
  });
  assert.equal(r.status, 403, 'an add-form token cannot file a report');
});

test('captcha: oversized tokens are refused without calling siteverify', async () => {
  const before = turnstileCalls;
  assert.equal((await submit({ ...VALID, 'cf-turnstile-response': 'x'.repeat(2049) })).status, 403);
  assert.equal(turnstileCalls, before);
});

test('captcha: no hostname allowlist means submissions refuse, not run open', async () => {
  delete env.TURNSTILE_HOSTNAMES;
  assert.equal((await submit(VALID)).status, 503);
});

test('captcha: Cloudflare test keys pass locally when example.com is allowed', async () => {
  env.TURNSTILE_HOSTNAMES = 'example.com';
  assert.equal((await submit({ ...VALID, 'cf-turnstile-response': 'test-key' })).status, 201);
  env.TURNSTILE_HOSTNAMES = 'clippycoder.github.io';
  assert.equal((await submit({ ...VALID, name: 'אחר', phone: '02-777-1111', 'cf-turnstile-response': 'test-key' })).status, 403,
    'and fail in production, where example.com is not allowed');
});

test('captcha: siteverify being unreachable fails closed', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('turnstile')) throw new Error('down');
    return orig(url, init);
  };
  assert.equal((await submit(VALID)).status, 403);
});
