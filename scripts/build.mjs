#!/usr/bin/env node
/**
 * Build the static dataset for the Kosher Restaurant Map.
 *
 *   1. Pull taxonomy terms (area / hechsher / restype) from the WP REST API.
 *   2. Page through the `rest` post type to get the full restaurant index.
 *   3. Fetch each restaurant's detail page -- but only for records that are new
 *      or whose `modified_gmt` advanced since the last run.
 *   4. Geocode `"<street>, <city>, ישראל"` via Nominatim, consulting a permanent
 *      on-disk cache and a hand-maintained override file first.
 *   5. Canonicalize city names and emit data/restaurants.json with facet counts.
 *
 * No dependencies: Node 20+ only.
 *
 * Usage:
 *   node scripts/build.mjs            # full run
 *   node scripts/build.mjs --sample   # 5 known records, for smoke-testing
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGazetteer, lookup as gazLookup, stripStreetPrefix } from './gazetteer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// data/ holds build state (geocode cache, hand-maintained fixups) and is not
// published. public/data/ holds the single document the site actually fetches.
const DATA = path.join(ROOT, 'data');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const OUTPUT = path.join(PUBLIC_DATA, 'restaurants.json');

const SITE = 'https://rest.jdn.co.il';
const API = `${SITE}/wp-json/wp/v2`;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Nominatim's usage policy requires an identifying User-Agent and at most one
// request per second. Both are why geocoding lives here and not in the browser.
const USER_AGENT =
  'KosherRestaurantMap/1.0 (+https://github.com/clippycoder/kosher-restaurant-map; build script)';

const SITE_DELAY_MS = 1000;      // politeness toward rest.jdn.co.il
const NOMINATIM_DELAY_MS = 1100; // >1s, per Nominatim policy
const MISS_RETRY_DAYS = 30;      // re-try failed geocodes after a month
const EMPTY_ADDRESS_ABORT = 0.2; // abort if >20% of details yield no address

// The five records verified by hand while planning. `--sample` restricts the run
// to these so extraction can be checked against known-good values.
const SAMPLE_IDS = [2699, 2685, 2655, 2653, 2647];

const args = new Set(process.argv.slice(2));
const SAMPLE = args.has('--sample');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serializes calls to one host and keeps a minimum gap between them. */
function rateLimiter(minGapMs) {
  let last = 0;
  let chain = Promise.resolve();
  return (fn) => {
    chain = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    return chain;
  };
}

const siteLimit = rateLimiter(SITE_DELAY_MS);
const geoLimit = rateLimiter(NOMINATIM_DELAY_MS);

/**
 * fetch with retry/backoff on 429 and 5xx, and a hard per-attempt timeout.
 *
 * The timeout matters: Node's fetch has none, so a connection that is accepted
 * but never answered (the source site runs Wordfence, which throttles
 * datacenter IPs) would otherwise hang the build until CI kills the job.
 */
async function request(url, { tries = 4, timeoutMs = 30_000, ...init } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(attempt * 2000);
    }
  }
  throw new Error(`${url} failed after ${tries} tries: ${lastErr.message}`);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

async function readJsonAt(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (err) {
    console.warn(`! could not parse ${path.relative(ROOT, p)}: ${err.message} -- using default`);
    return fallback;
  }
}

const readJson = (file, fallback) => readJsonAt(path.join(DATA, file), fallback);

const writeJsonAt = (p, value) =>
  writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');

const writeJson = (file, value) => writeJsonAt(path.join(DATA, file), value);

// ---------------------------------------------------------------------------
// 1. taxonomies
// ---------------------------------------------------------------------------

async function fetchTaxonomy(name) {
  const res = await siteLimit(() =>
    request(`${API}/${name}?per_page=100&_fields=id,name,count`));
  const terms = await res.json();
  return new Map(terms.map((t) => [t.id, decodeEntities(t.name).trim()]));
}

// ---------------------------------------------------------------------------
// 2. restaurant index
// ---------------------------------------------------------------------------

async function fetchIndex() {
  const fields = 'id,link,title,modified_gmt,area,hechsher,restype';
  const out = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${API}/rest?per_page=100&page=${page}&orderby=id&order=asc&_fields=${fields}`;
    const res = await siteLimit(() => request(url));
    if (page === 1) {
      totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
      console.log(`  index: ${res.headers.get('x-wp-total')} records across ${totalPages} pages`);
    }
    out.push(...(await res.json()));
    page++;
  } while (page <= totalPages);

  return out;
}

// ---------------------------------------------------------------------------
// 3. detail page extraction
// ---------------------------------------------------------------------------

/**
 * Fields render as labelled list items, e.g.
 *   <span class="elementor-icon-list-text">כתובת: המרפא 1</span>
 * Matching on the label (rather than on position, as the old worker did) keeps
 * this stable when the site reorders or adds rows.
 */
function parseDetail(html) {
  const items = [...html.matchAll(/elementor-icon-list-text[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const field = (label) => {
    const hit = items.find((i) => i.startsWith(`${label}:`));
    return hit ? hit.slice(label.length + 1).trim() : '';
  };

  // Attribute order varies between themes, so try both arrangements.
  const ogImage =
    html.match(/<meta[^>]+property=["']og:image["'][^>]*\scontent=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*\sproperty=["']og:image["']/i);

  return {
    address: field('כתובת'),
    city: field('עיר'),
    phone: field('טלפון'),
    image: ogImage ? decodeEntities(ogImage[1]) : '',
  };
}

async function fetchDetail(link) {
  const res = await siteLimit(() => request(link));
  return parseDetail(await res.text());
}

// ---------------------------------------------------------------------------
// 4. geocoding
// ---------------------------------------------------------------------------

/** Normalizes punctuation seen live in the source data, e.g. "יצחק רבין,19". */
function normalizePart(s) {
  return String(s || '')
    .replace(/،/g, ',')     // Arabic comma
    .replace(/,(\S)/g, ', $1')   // "רבין,19" -> "רבין, 19"
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
}

/** Yod-insensitive key: the source spells e.g. both קרית ים and קריית ים. */
const yodKey = (s) =>
  String(s || '').replace(/קריית/g, 'קרית').replace(/(?<=\S)יי(?=\S)/g, 'י');

/**
 * Builds progressively looser geocode queries, best first.
 *
 * The address field is inconsistent upstream: 82% of records already embed the
 * city and/or "ישראל", so naively appending them produced doubled queries like
 * "רוגוזין 19, אשדוד, ישראל, אשדוד, ישראל", which Nominatim rejects outright.
 * Many also carry a business-name prefix ("מגדלי אביסרור, שדרות רגר 53") that
 * has to come off before the street will resolve.
 */
function geoVariants(address, city) {
  const c = normalizePart(city);
  if (!c) return [];

  let parts = normalizePart(address).split(',').map((p) => p.trim()).filter(Boolean);
  // Drop segments that merely repeat the city or the country.
  parts = parts.filter((p) => p !== 'ישראל' && yodKey(p) !== yodKey(c));

  const tail = `${c}, ישראל`;
  const out = [];
  const push = (q, precision) => {
    if (q && !out.some((v) => v.q === q)) out.push({ q, precision });
  };

  if (parts.length) push(`${parts.join(', ')}, ${tail}`, 'address');

  // The segment carrying a house number is the actual street address. It must
  // contain letters too -- "יצחק רבין,19" splits into a name and a bare "19",
  // and querying the number alone is meaningless.
  const numbered = parts.find((p) => /\d/.test(p) && /[\u05D0-\u05EA]/.test(p));
  if (numbered) {
    const core = numbered.replace(/^רח['׳]?\s*/, '').trim();
    if (core) push(`${core}, ${tail}`, 'address');
    const streetOnly = core.replace(/\s*\d+\s*$/, '').trim();
    if (streetOnly && streetOnly !== core) push(`${streetOnly}, ${tail}`, 'street');
  }

  // Last resort: the city centre.
  push(tail, 'city');
  return out;
}

function isStaleMiss(entry) {
  if (!entry || entry.lat !== null) return false;
  if (!entry.ts) return true;
  const age = (Date.now() - Date.parse(entry.ts)) / 86_400_000;
  return !Number.isFinite(age) || age > MISS_RETRY_DAYS;
}

async function geocode(query, cache, overrides, stats) {
  if (!query) return null;

  if (overrides[query]) {
    stats.override++;
    const { lat, lon } = overrides[query];
    return { lat: Number(lat), lon: Number(lon) };
  }

  const cached = cache[query];
  if (cached && !isStaleMiss(cached)) {
    stats.cached++;
    return cached.lat === null ? null : { lat: cached.lat, lon: cached.lon };
  }

  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=il&q=${encodeURIComponent(query)}`;
  let result = null;
  try {
    const res = await geoLimit(() => request(url, { tries: 3 }));
    const body = await res.json();
    if (Array.isArray(body) && body.length) {
      result = { lat: Number(body[0].lat), lon: Number(body[0].lon) };
    }
  } catch (err) {
    console.warn(`  ! geocode failed for "${query}": ${err.message}`);
    stats.error++;
    return cached && cached.lat !== null ? { lat: cached.lat, lon: cached.lon } : null;
  }

  cache[query] = result
    ? { lat: result.lat, lon: result.lon, ts: new Date().toISOString() }
    : { lat: null, lon: null, ts: new Date().toISOString() };

  if (result) stats.hit++;
  else stats.miss++;
  return result;
}

/** Great-circle distance in km, used to reject wrong-city geocodes. */
function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Generates candidate "<street>, <number>" readings of a messy address, best
 * first, for the gazetteer to adjudicate.
 *
 * One reading is not enough: the city is often appended without a comma
 * ("שד' בן צבי 11 ירושלים"), and a mall name frequently precedes the real
 * street ("קניון סנטר 1, ירמיהו 43"), so the first number encountered is
 * regularly the wrong one. Emitting several readings and letting the gazetteer
 * pick the one it actually knows is far more reliable than guessing here.
 */
function addressCandidates(address, city) {
  const cityKey = yodKey(normalizePart(city));
  let text = normalizePart(address)
    .replace(/\([^)]*\)/g, ' ')          // drop parentheticals
    .replace(/\s+-\s+/g, ', ')           // "X - Y" behaves like a comma
    .replace(/\s+/g, ' ');

  const segments = text.split(',').map((p) => p.trim()).filter(Boolean)
    .map((p) => {
      // Strip a trailing city name that was appended without a comma.
      const words = p.split(' ');
      for (let take = Math.min(3, words.length - 1); take >= 1; take--) {
        const tail = words.slice(-take).join(' ');
        if (yodKey(tail) === cityKey) return words.slice(0, -take).join(' ').trim();
      }
      return p;
    })
    .filter((p) => p && p !== 'ישראל' && yodKey(p) !== cityKey);

  const withHouse = [];
  const withoutHouse = [];

  for (const seg of segments) {
    // "<name> <number>" anywhere in the segment, not only at its end.
    const m = seg.match(/^(.*?[א-ת].*?)\s+(\d+[א-ת]?)(?:\s|$)/);
    if (m && m[1].trim()) {
      withHouse.push({ street: stripStreetPrefix(m[1]), house: m[2] });
    }
    if (/[א-ת]/.test(seg)) {
      withoutHouse.push({ street: stripStreetPrefix(seg.replace(/\s*\d+[א-ת]?\s*$/, '')), house: '' });
    }
  }

  // A bare "19" segment belongs to the segment before it ("יצחק רבין,19").
  for (let i = 1; i < segments.length; i++) {
    if (/^\d+[א-ת]?$/.test(segments[i])) {
      withHouse.unshift({ street: stripStreetPrefix(segments[i - 1]), house: segments[i] });
    }
  }

  const seen = new Set();
  return [...withHouse, ...withoutHouse].filter((c) => {
    if (!c.street || c.street.length < 2) return false;
    const k = `${c.street}|${c.house}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 5. city canonicalization
// ---------------------------------------------------------------------------

/**
 * `עיר` is free-text postmeta, not a taxonomy, so spellings drift. Normalizing
 * here keeps the city filter from splitting one city across several entries.
 */
function normalizeCity(raw, aliases) {
  let c = String(raw || '')
    .replace(/[״“”"]/g, '"')   // unify gershayim / smart quotes
    .replace(/[׳‘’']/g, "'")
    .replace(/[-‐-―]/g, ' ')        // hyphen variants -> space
    .replace(/\s+/g, ' ')
    .trim();
  if (!c) return '';
  // Alias lookup is case-insensitive on the normalized form.
  const key = Object.keys(aliases).find(
    (k) => normalizeCityKey(k) === normalizeCityKey(c));
  return key ? aliases[key] : c;
}

const normalizeCityKey = (s) =>
  String(s).replace(/[״“”"'׳‘’]/g, '')
    .replace(/[-‐-―\s]+/g, '')
    .trim();

/** Collapses spelling-only differences so one city is never two filter rows. */
const spellKey = (s) => yodKey(normalizeCityKey(s)).replace(/(?<=\S)וו(?=\S)/g, 'ו');

/**
 * Where two spellings of one city both appear, keep the commonest (ties go to
 * the longer, which is the official form: קריית over קרית).
 */
function unifySpellings(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r.city) continue;
    const k = spellKey(r.city);
    if (!groups.has(k)) groups.set(k, new Map());
    const m = groups.get(k);
    m.set(r.city, (m.get(r.city) || 0) + 1);
  }
  const canonical = new Map();
  for (const [k, m] of groups) {
    const best = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    canonical.set(k, best);
    if (m.size > 1) {
      console.log(`  unified ${[...m.keys()].map((x) => `"${x}"`).join(' / ')} -> "${best}"`);
    }
  }
  for (const r of records) if (r.city) r.city = canonical.get(spellKey(r.city));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  console.log(SAMPLE ? '== SAMPLE RUN (5 records) ==' : '== full build ==');

  const [prev, geocache, overrides, cityAliases] = await Promise.all([
    readJsonAt(OUTPUT, { restaurants: [] }),
    readJson('geocache.json', {}),
    readJson('overrides.json', {}),
    readJson('city-aliases.json', {}),
  ]);
  const prevById = new Map((prev.restaurants || []).map((r) => [r.id, r]));

  console.log('- taxonomies');
  const [areas, hechsherim, types] = await Promise.all([
    fetchTaxonomy('area'),
    fetchTaxonomy('hechsher'),
    fetchTaxonomy('restype'),
  ]);
  console.log(`  area=${areas.size} hechsher=${hechsherim.size} restype=${types.size}`);

  console.log('- index');
  let index = await fetchIndex();
  if (SAMPLE) index = index.filter((r) => SAMPLE_IDS.includes(r.id));

  console.log(`- details (${index.length} records; fetching changed only)`);
  const stats = { fetched: 0, reused: 0, failed: 0, emptyAddress: 0 };
  const records = [];

  for (const row of index) {
    const old = prevById.get(row.id);
    const unchanged = old && old.modified === row.modified_gmt && old.address !== undefined;

    let detail;
    if (unchanged) {
      detail = { address: old.address, city: old.cityRaw ?? old.city, phone: old.phone, image: old.image };
      stats.reused++;
    } else {
      try {
        detail = await fetchDetail(row.link);
        stats.fetched++;
      } catch (err) {
        console.warn(`  ! detail failed for ${row.id}: ${err.message}`);
        stats.failed++;
        // Keep the previous snapshot rather than dropping the restaurant.
        if (!old) continue;
        detail = { address: old.address, city: old.cityRaw ?? old.city, phone: old.phone, image: old.image };
      }
      if (stats.fetched % 25 === 0 && stats.fetched) {
        console.log(`    ${stats.fetched} fetched...`);
      }
    }

    if (!detail.address) stats.emptyAddress++;

    records.push({
      id: row.id,
      name: decodeEntities(row.title?.rendered || '').trim(),
      address: detail.address || '',
      cityRaw: detail.city || '',
      area: areas.get(row.area?.[0]) || '',
      kashrut: hechsherim.get(row.hechsher?.[0]) || '',
      type: types.get(row.restype?.[0]) || '',
      phone: detail.phone || '',
      image: detail.image || '',
      link: row.link,
      modified: row.modified_gmt,
    });
  }

  // Guard: if extraction silently broke, fail loudly instead of committing a
  // gutted dataset over a good one.
  const emptyRatio = records.length ? stats.emptyAddress / records.length : 0;
  if (emptyRatio > EMPTY_ADDRESS_ABORT && prevById.size) {
    throw new Error(
      `${(emptyRatio * 100).toFixed(1)}% of records have no address ` +
      `(limit ${EMPTY_ADDRESS_ABORT * 100}%) -- the page template likely changed. Aborting.`);
  }

  console.log(`  fetched=${stats.fetched} reused=${stats.reused} failed=${stats.failed} ` +
              `no-address=${stats.emptyAddress}`);

  console.log('- cities');
  for (const r of records) r.city = normalizeCity(r.cityRaw, cityAliases);
  unifySpellings(records);

  // The address sometimes names a different town than the city field. That is a
  // genuine upstream error and no rule can say which field is right, so surface
  // it for a human instead of silently trusting one.
  const knownCities = new Set(records.map((r) => r.city).filter(Boolean));
  const contradictions = records.filter((r) => {
    if (!r.city || !r.address) return false;
    return normalizePart(r.address).split(',').map((p) => p.trim())
      .some((p) => knownCities.has(p) && yodKey(p) !== yodKey(r.city));
  });
  if (contradictions.length) {
    console.log(`  ! ${contradictions.length} records whose address names a different city ` +
                `than the city field -- verify by hand:`);
    for (const r of contradictions) {
      console.log(`      ${r.id}  city="${r.city}"  address="${r.address}"`);
    }
  }

  console.log('- geocoding');
  const geoStats = { cached: 0, hit: 0, miss: 0, error: 0, override: 0, skipped: 0 };
  const gazStats = { address: 0, street: 0, cities: 0, rejected: 0 };

  // City centres first: they anchor the distance check and drive the radius
  // fallback when a town has no administrative boundary in OSM.
  const centres = new Map();
  for (const city of new Set(records.map((r) => r.city).filter(Boolean))) {
    const c = await geocode(`${city}, ישראל`, geocache, overrides, geoStats);
    if (c) centres.set(city, [c.lat, c.lon]);
  }

  // How far from the city centre a pin may sit before we distrust it. Generous
  // enough for sprawling municipalities, tight enough to catch a result that
  // matched a same-named street in another town.
  const MAX_KM = 25;
  const plausible = (city, lat, lon) => {
    const c = centres.get(city);
    return !c || distanceKm(c, [lat, lon]) <= MAX_KM;
  };

  const gazCache = new Map();
  const gazFor = async (city) => {
    if (!gazCache.has(city)) {
      gazCache.set(city, await getGazetteer(city, centres.get(city)));
      gazStats.cities++;
    }
    return gazCache.get(city);
  };

  let done = 0;
  for (const r of records) {
    // A street with no city is not geocodable: "הרצל 5" exists in dozens of
    // Israeli towns and any geocoder would happily return the wrong one. Leave
    // it unmapped so it shows up in the UI's "no exact location" panel rather
    // than dropping a confidently wrong pin.
    if (!r.city) {
      r.precision = null;
      r.lat = null;
      r.lon = null;
      geoStats.skipped++;
      continue;
    }

    r.precision = null;
    r.lat = null;
    r.lon = null;
    let gazHit = null;

    // 1. Local OSM gazetteer -- exact house numbers, no text-matching guesswork.
    // Results are memoised into geocache.json under a `gaz:` key so that later
    // builds (notably in CI, which starts with an empty .cache/) never have to
    // hit Overpass again.
    const candidates = addressCandidates(r.address, r.city);
    if (candidates.length) {
      const keyed = candidates.map((c) => ({ ...c, key: `gaz:${r.city}|${c.street}|${c.house}` }));
      const stale = (c) => geocache[c.key] === undefined || isStaleMiss(geocache[c.key]);
      const needsFetch = keyed.some(stale);
      const gaz = needsFetch ? await gazFor(r.city) : null;

      let best = null;
      for (const c of keyed) {
        let entry = geocache[c.key];
        if (entry === undefined || (gaz && isStaleMiss(entry))) {
          const found = gaz ? gazLookup(gaz, c.street, c.house) : null;
          entry = found
            ? { lat: found.lat, lon: found.lon, precision: found.precision,
                ts: new Date().toISOString() }
            : { lat: null, lon: null, ts: new Date().toISOString() };
          geocache[c.key] = entry;
        }
        if (entry.lat === null) continue;
        if (!plausible(r.city, entry.lat, entry.lon)) continue;
        if (entry.precision === 'address') { best = entry; break; }   // can't do better
        if (!best) best = entry;
      }
      if (best) {
        gazHit = best;
        gazStats[best.precision]++;
      }
    }

    // 2. Nominatim. Precision decides, not source order: a house-number match
    //    from either source beats a street-level one from the other.
    if (gazHit?.precision === 'address') {
      Object.assign(r, { precision: 'address', lat: gazHit.lat, lon: gazHit.lon });
    } else {
      let fallback = gazHit ?? null;   // gazetteer street-level, if any
      for (const variant of geoVariants(r.address, r.city)) {
        const coords = await geocode(variant.q, geocache, overrides, geoStats);
        if (!coords) continue;
        if (variant.precision !== 'city' && !plausible(r.city, coords.lat, coords.lon)) {
          gazStats.rejected++;   // right street name, wrong town
          continue;
        }
        if (variant.precision === 'address') { fallback = { ...coords, precision: 'address' }; break; }
        // Keep whichever candidate is more precise.
        const rank = { address: 3, street: 2, city: 1 };
        if (!fallback || rank[variant.precision] > rank[fallback.precision]) {
          fallback = { ...coords, precision: variant.precision };
        }
      }
      if (fallback) {
        r.precision = fallback.precision;
        r.lat = fallback.lat;
        r.lon = fallback.lon;
      }
    }

    if (++done % 100 === 0) console.log(`    ${done}/${records.length} located...`);
  }
  console.log(`  gazetteer: ${gazStats.address} house-number, ${gazStats.street} street ` +
              `(${gazStats.cities} cities); ${gazStats.rejected} wrong-town results rejected`);
  console.log(`  cached=${geoStats.cached} new=${geoStats.hit} miss=${geoStats.miss} ` +
              `override=${geoStats.override} error=${geoStats.error} ` +
              `no-city=${geoStats.skipped}`);

  // -- facets ---------------------------------------------------------------
  const tally = (key) => {
    const m = new Map();
    for (const r of records) {
      if (!r[key]) continue;
      m.set(r[key], (m.get(r[key]) || 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'));
  };

  // Each city carries its region so the UI can group and cross-filter.
  const cityArea = new Map();
  for (const r of records) {
    if (!r.city || !r.area) continue;
    if (!cityArea.has(r.city)) cityArea.set(r.city, new Map());
    const m = cityArea.get(r.city);
    m.set(r.area, (m.get(r.area) || 0) + 1);
  }
  const cities = tally('city').map((c) => {
    const m = cityArea.get(c.name);
    const ranked = m ? [...m.entries()].sort((a, b) => b[1] - a[1]) : [];
    if (ranked.length > 1) {
      console.warn(`  ! city "${c.name}" spans regions: ${ranked.map(([a, n]) => `${a}(${n})`).join(', ')}`);
    }
    return { ...c, area: ranked.length ? ranked[0][0] : '' };
  });

  const rare = cities.filter((c) => c.count < 3).map((c) => `${c.name}(${c.count})`);
  if (rare.length) {
    console.log(`  low-count cities -- check for spelling variants to add to ` +
                `city-aliases.json:\n    ${rare.join(', ')}`);
  }

  const mapped = records.filter((r) => r.lat !== null).length;
  const payload = {
    generated: new Date().toISOString(),
    source: SITE,
    counts: { total: records.length, mapped, unmapped: records.length - mapped },
    facets: {
      cities,
      areas: tally('area'),
      hechsherim: tally('kashrut'),
      types: tally('type'),
    },
    restaurants: records.sort((a, b) => a.name.localeCompare(b.name, 'he')),
  };

  if (SAMPLE) {
    console.log('\n-- sample results --');
    for (const r of payload.restaurants) {
      console.log(`  ${r.id} ${r.name}\n      address=${r.address} | city=${r.city} | ` +
                  `area=${r.area} | type=${r.type} | kashrut=${r.kashrut}\n` +
                  `      -> ${r.lat},${r.lon} (${r.precision})`);
    }
    await writeJson('geocache.json', geocache);
    console.log('\nSample run: geocache.json updated, restaurants.json left untouched.');
    return;
  }

  await mkdir(PUBLIC_DATA, { recursive: true });
  await writeJsonAt(OUTPUT, payload);
  await writeJson('geocache.json', geocache);

  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s -- ` +
              `${payload.counts.total} restaurants, ${mapped} mapped, ` +
              `${payload.counts.unmapped} unmapped`);
}

main().catch((err) => {
  console.error(`\nBUILD FAILED: ${err.message}`);
  process.exit(1);
});
