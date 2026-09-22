#!/usr/bin/env node
/**
 * Checks the generated dataset against the live API and exercises the filter
 * semantics the frontend relies on (OR within a facet, AND across facets).
 *
 *   node scripts/verify.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://rest.jdn.co.il/wp-json/wp/v2';
const UA = 'KosherRestaurantMap/1.0 (verify)';

let failures = 0;
const ok = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!pass) failures++;
};

const data = JSON.parse(
  await readFile(path.join(ROOT, 'public', 'data', 'restaurants.json'), 'utf8'));
const rows = data.restaurants;

// --- filter semantics, mirroring public/app.js ------------------------------
const FACETS = { types: 'type', areas: 'area', cities: 'city', hechsherim: 'kashrut' };

function select(sel = {}, q = '') {
  const needle = q.toLowerCase();
  return rows.filter((r) => {
    for (const [facet, prop] of Object.entries(FACETS)) {
      const want = sel[facet];
      if (want && want.length && !want.includes(r[prop])) return false;
    }
    return !needle ||
      r.name.toLowerCase().includes(needle) ||
      r.address.toLowerCase().includes(needle) ||
      r.city.toLowerCase().includes(needle);
  });
}

const facetCount = (facet, name) =>
  data.facets[facet].find((f) => f.name === name)?.count ?? 0;

// --- 1. live counts ---------------------------------------------------------
console.log('\n1. dataset vs. live API');

const liveTax = async (name) => {
  const res = await fetch(`${API}/${name}?per_page=100&_fields=name,count`,
    { headers: { 'User-Agent': UA } });
  return new Map((await res.json()).map((t) => [t.name.trim(), t.count]));
};

const idxRes = await fetch(`${API}/rest?per_page=1&_fields=id`, { headers: { 'User-Agent': UA } });
const liveTotal = Number(idxRes.headers.get('x-wp-total'));

ok('record count matches the API', data.counts.total === liveTotal,
  `dataset=${data.counts.total} live=${liveTotal}`);

// A post can carry more than one term (live area counts sum to 650 across 641
// posts), and we keep only the primary. So ours must never EXCEED live, and the
// facet must still account for every record.
for (const [tax, facet] of [['restype', 'types'], ['area', 'areas'], ['hechsher', 'hechsherim']]) {
  const live = await liveTax(tax);
  const over = [...live.entries()]
    .filter(([name, count]) => facetCount(facet, name) > count)
    .map(([name, count]) => `${name}: live=${count} ours=${facetCount(facet, name)}`);
  ok(`${facet} never exceeds the ${tax} taxonomy counts`, over.length === 0, over.join('; '));

  const unknown = data.facets[facet]
    .filter((f) => !live.has(f.name))
    .map((f) => f.name);
  ok(`${facet} contains no terms absent from ${tax}`, unknown.length === 0, unknown.join('; '));
}

// 19 posts carry no restype term upstream, so the facet legitimately accounts
// for fewer than every record. Assert the shortfall is exactly the untyped set.
const typeSum = data.facets.types.reduce((a, t) => a + t.count, 0);
const untyped = rows.filter((r) => !r.type).length;
console.log(`  INFO  ${untyped} records have no type upstream` +
  ` (they are excluded whenever a type filter is active)`);
ok('type facet plus untyped records accounts for the total',
  typeSum + untyped === data.counts.total,
  `${typeSum} + ${untyped} vs ${data.counts.total}`);

// --- 2. data integrity ------------------------------------------------------
console.log('\n2. data integrity');

// A missing city is an upstream data gap, not a build bug -- such records stay
// unmapped by design. Fail only if it becomes widespread.
const noCity = rows.filter((r) => !r.city);
console.log(`  INFO  ${noCity.length} records have no city upstream` +
  (noCity.length ? ` (ids ${noCity.slice(0, 8).map((r) => r.id).join(', ')})` : ''));
ok('missing-city records stay under 5%', noCity.length / rows.length < 0.05,
  `${noCity.length}/${rows.length}`);

const noAddress = rows.filter((r) => !r.address);
ok('address extraction is healthy (<20% empty)',
  noAddress.length / rows.length < 0.2,
  `${noAddress.length}/${rows.length} empty`);

const cityAreas = new Map();
for (const r of rows) {
  if (!r.city) continue;
  if (!cityAreas.has(r.city)) cityAreas.set(r.city, new Set());
  cityAreas.get(r.city).add(r.area);
}
// Some cities are filed under two regions upstream (בית שמש appears as both
// מרכז and ירושלים). We keep the commonest; this is reported, not enforced.
const multiArea = [...cityAreas].filter(([, s]) => s.size > 1);
if (multiArea.length) {
  console.log(`  INFO  ${multiArea.length} cities span regions upstream: ` +
    multiArea.map(([c, s]) => `${c} (${[...s].join('/')})`).join(', '));
}
ok('the region facet still accounts for every record',
  data.facets.areas.reduce((a, f) => a + f.count, 0) === rows.length);

// Near-duplicate detection: strip punctuation/spaces and look for collisions.
const key = (s) => s.replace(/["'׳״‘’“”]/g, '')
  .replace(/[-‐-―\s]+/g, '');
const byKey = new Map();
for (const c of data.facets.cities) {
  const k = key(c.name);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(c.name);
}
const dupes = [...byKey.values()].filter((v) => v.length > 1);
ok('no near-duplicate city spellings', dupes.length === 0,
  dupes.map((d) => d.join(' ~ ')).join('; '));

const mapped = rows.filter((r) => r.lat !== null);
ok('geocoding coverage >=85%', mapped.length / rows.length >= 0.85,
  `${mapped.length}/${rows.length} mapped`);

const byPrecision = rows.reduce((m, r) => {
  m[r.precision ?? 'unmapped'] = (m[r.precision ?? 'unmapped'] || 0) + 1;
  return m;
}, {});
console.log(`  INFO  precision: ${JSON.stringify(byPrecision)}`);
const precise = byPrecision.address || 0;
ok('at least half of pins are address-precise', precise / rows.length >= 0.5,
  `${precise}/${rows.length} address-precise`);
ok('precision values are from the known set',
  rows.every((r) => [null, 'address', 'street', 'city'].includes(r.precision)));
ok('counts block agrees with the records', data.counts.mapped === mapped.length);

const badCoords = mapped.filter(
  (r) => !(r.lat > 29 && r.lat < 34 && r.lon > 33.5 && r.lon < 36.5));
ok('all coordinates fall inside Israel', badCoords.length === 0,
  badCoords.slice(0, 5).map((r) => `${r.name}(${r.lat},${r.lon})`).join('; '));

// --- 3. filter semantics ----------------------------------------------------
console.log('\n3. filter semantics');

ok('no filters returns everything', select().length === data.counts.total);

const [c1, c2] = data.facets.cities.slice(0, 2).map((c) => c.name);
const union = select({ cities: [c1, c2] }).length;
ok('two cities union within the facet',
  union === facetCount('cities', c1) + facetCount('cities', c2),
  `${c1}+${c2} = ${union}`);

const meat = 'בשרי';
const cross = select({ cities: [c1, c2], types: [meat] }).length;
const manual = rows.filter((r) => [c1, c2].includes(r.city) && r.type === meat).length;
ok('facets intersect rather than union', cross === manual && cross <= union,
  `${cross} (<= ${union})`);

const singleType = select({ types: [meat] }).length;
ok('single type matches its facet count', singleType === facetCount('types', meat),
  `${singleType}`);

const impossible = select({ types: [meat], hechsherim: ['__nope__'] }).length;
ok('an unsatisfiable combination yields zero', impossible === 0);

const q = rows[0].name.slice(0, 4);
ok('free-text search matches by name', select({}, q).some((r) => r.id === rows[0].id),
  `"${q}"`);

// --- 4. shape ---------------------------------------------------------------
console.log('\n4. payload shape');

const required = ['id', 'name', 'address', 'city', 'area', 'kashrut', 'type', 'link', 'lat', 'lon'];
const missing = rows.filter((r) => required.some((k) => !(k in r)));
ok('every record has the expected keys', missing.length === 0,
  missing.slice(0, 3).map((r) => r.id).join(', '));

ok('facet lists are sorted by descending count',
  Object.values(data.facets).every((list) =>
    list.every((f, i) => i === 0 || list[i - 1].count >= f.count)));

ok('every city carries a region',
  data.facets.cities.every((c) => c.area), '');

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
