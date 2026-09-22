/**
 * Local address gazetteer built from OSM via the Overpass API.
 *
 * Nominatim's free-text matching is poor on Hebrew addresses -- it misses
 * ordinary streets that OSM plainly contains (יפו 217, שמגר 16, אגריפס 109).
 * Pulling a city's address points once and matching them locally is both more
 * accurate (exact house numbers) and cheaper than repeated geocoder queries.
 *
 * Gazetteers are cached under .cache/gazetteer/ and are not committed; the
 * resolved coordinates land in data/geocache.json, which is.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'gazetteer');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'KosherRestaurantMap/1.0 (+https://github.com/clippycoder/kosher-restaurant-map)';
const GAP_MS = 4000;   // Overpass is a shared volunteer service; be gentle.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

// --- normalization ----------------------------------------------------------

/** Yod/vav doubling and gershayim vary freely between the two datasets. */
export const normStreet = (s) =>
  String(s || '')
    .replace(/קריית/g, 'קרית')
    .replace(/(?<=\S)יי(?=\S)/g, 'י')
    .replace(/(?<=\S)וו(?=\S)/g, 'ו')
    .replace(/["'׳״‘’“”]/g, '')
    .replace(/[-‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "שד' הנשיא" and "שדרות הנשיא" must land on the same key. */
export const stripStreetPrefix = (s) =>
  normStreet(s).replace(/^(רחוב|רח|שדרות|שד|סמטת|סמטה|ככר|כיכר|שכונת)\s+/, '').trim();

const keysFor = (name) => {
  const a = normStreet(name);
  const b = stripStreetPrefix(name);
  return a === b ? [a] : [a, b];
};

/** "12א" -> also try "12"; ranges like "10-12" -> try each end. */
const houseKeys = (h) => {
  const s = String(h || '').trim();
  const out = [s];
  const digits = s.match(/\d+/);
  if (digits && digits[0] !== s) out.push(digits[0]);
  return [...new Set(out.filter(Boolean))];
};

// --- fetching ---------------------------------------------------------------

async function overpass(query) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(240_000),     // Overpass can be slow, not endless
          headers: {
            'User-Agent': UA,                       // Overpass 406s without one
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ data: query }).toString(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
        await sleep(attempt * 4000);
      }
    }
  }
  throw lastErr;
}

const byName = (city) => `[out:json][timeout:180];
area["boundary"="administrative"]["name"="${city}"]->.a;
(
  node(area.a)["addr:housenumber"]["addr:street"];
  way(area.a)["addr:housenumber"]["addr:street"];
  way(area.a)["highway"]["name"];
);
out center tags;`;

const byRadius = (lat, lon, r) => `[out:json][timeout:180];
(
  node(around:${r},${lat},${lon})["addr:housenumber"]["addr:street"];
  way(around:${r},${lat},${lon})["addr:housenumber"]["addr:street"];
  way(around:${r},${lat},${lon})["highway"]["name"];
);
out center tags;`;

// --- building ---------------------------------------------------------------

function compact(elements) {
  const houses = {};   // street -> { houseNumber: [lat, lon] }
  const streets = {};  // street -> [latSum, lonSum, n]

  for (const el of elements) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    if (t['addr:housenumber'] && t['addr:street']) {
      for (const k of keysFor(t['addr:street'])) {
        (houses[k] ||= {})[String(t['addr:housenumber']).trim()] = [lat, lon];
      }
    }
    if (t.highway && t.name) {
      for (const k of keysFor(t.name)) {
        const acc = (streets[k] ||= [0, 0, 0]);
        acc[0] += lat; acc[1] += lon; acc[2] += 1;
      }
    }
  }
  // Collapse street accumulators to a mean point.
  for (const k of Object.keys(streets)) {
    const [sLat, sLon, n] = streets[k];
    streets[k] = [sLat / n, sLon / n];
  }
  return { houses, streets };
}

const slug = (s) => Buffer.from(s).toString('base64url').slice(0, 80);

/**
 * Returns { houses, streets } for a city, fetching from Overpass on first use.
 * `centre` ([lat, lon]) enables the radius fallback for places without a
 * matching administrative boundary.
 */
export async function getGazetteer(city, centre) {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, `${slug(city)}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* refetch */ }
  }

  let data;
  try {
    data = await overpass(byName(city));
    if (!data.elements?.length && centre) {
      data = await overpass(byRadius(centre[0], centre[1], 9000));
    }
  } catch (err) {
    console.warn(`    ! gazetteer fetch failed for ${city}: ${err.message}`);
    return { houses: {}, streets: {} };
  }

  const g = compact(data.elements || []);
  await writeFile(file, JSON.stringify(g), 'utf8');
  return g;
}

// --- lookup -----------------------------------------------------------------

/** Similarity in [0,1] -- the two datasets disagree on spellings often enough
 *  that exact matching alone leaves real streets unfound (לואיס בריינדס vs
 *  לואיס ברנדייס, גנרל פייר קניג vs פייר קניג). */
function similarity(a, b) {
  if (a === b) return 1;
  const [s, t] = a.length >= b.length ? [a, b] : [b, a];
  if (!s.length) return 1;
  if (s.includes(t) && t.length >= 4) return 0.95;
  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1,
        last + (s[i - 1] === t[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return 1 - prev[t.length] / s.length;
}

/** Closest street key in the gazetteer, or null below the threshold. */
function fuzzyStreet(gaz, street, index, min = 0.84) {
  const want = stripStreetPrefix(street);
  if (!want || want.length < 3) return null;
  let best = null;
  for (const k of Object.keys(index)) {
    const score = similarity(want, k);
    if (score >= min && (!best || score > best.score)) best = { k, score };
  }
  return best ? best.k : null;
}

/**
 * Resolves a street + house number against a gazetteer.
 * Returns { lat, lon, precision } or null.
 */
export function lookup(gaz, street, house) {
  if (!street) return null;

  const houseKeysToTry = [...keysFor(street)];
  const fuzzyHouse = fuzzyStreet(gaz, street, gaz.houses);
  if (fuzzyHouse && !houseKeysToTry.includes(fuzzyHouse)) houseKeysToTry.push(fuzzyHouse);

  for (const k of houseKeysToTry) {
    const onStreet = gaz.houses[k];
    if (!onStreet) continue;

    if (house) {
      for (const h of houseKeys(house)) {
        if (onStreet[h]) {
          const [lat, lon] = onStreet[h];
          return { lat, lon, precision: 'address' };
        }
      }
      // Nearest numbered building on the same street: still the right block.
      const want = Number(String(house).match(/\d+/)?.[0]);
      if (Number.isFinite(want)) {
        let best = null;
        for (const [h, coords] of Object.entries(onStreet)) {
          const n = Number(String(h).match(/\d+/)?.[0]);
          if (!Number.isFinite(n)) continue;
          const d = Math.abs(n - want);
          if (!best || d < best.d) best = { d, coords };
        }
        if (best && best.d <= 20) {
          return { lat: best.coords[0], lon: best.coords[1], precision: 'address' };
        }
      }
    }
  }

  const streetKeysToTry = [...keysFor(street)];
  const fuzzyOnly = fuzzyStreet(gaz, street, gaz.streets);
  if (fuzzyOnly && !streetKeysToTry.includes(fuzzyOnly)) streetKeysToTry.push(fuzzyOnly);

  for (const k of streetKeysToTry) {
    if (gaz.streets[k]) {
      const [lat, lon] = gaz.streets[k];
      return { lat, lon, precision: 'street' };
    }
  }
  return null;
}
