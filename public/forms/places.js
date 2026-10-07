/**
 * Address suggestions as you type, from Photon (photon.komoot.io): free, no
 * key, built for search-as-you-type over OpenStreetMap -- the same data the
 * map's own geocoder uses. Nominatim's policy forbids autocomplete; Google's
 * needs a billing account.
 *
 * Photon asks for fair use, so requests are debounced, cancelled when
 * superseded, and cached. If it's unreachable the field stays a plain text box.
 */

const PHOTON = 'https://photon.komoot.io/api/';
const ISRAEL_BBOX = '34.2,29.4,35.95,33.4';
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

// Transport stops and junctions: OSM names them after the streets they sit
// on ("שדרות יגאל אלון/3855"), so they crowd out the street itself, and a
// restaurant's address is never one of them.
const NOT_ADDRESSES = new Set(['bus_stop', 'motorway_junction', 'platform', 'stop', 'stop_position',
  'station', 'halt', 'tram_stop', 'bus_station', 'traffic_signals', 'crossing']);

// "Street", "St", "Road", "רחוב"... are not part of OSM's names (it has
// שדרות יגאל אלון, "Yigal Alon Boulevard"), and with them in the query Photon
// often finds nothing at all. Removed before searching.
const STREET_WORDS = /(^|[\s,])(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|רחוב|רח['׳]?)\.?(?=[\s,]|$)/giu;
// Only in a street address (one with a number): "Boulevard Mall" is a name.
export const cleanQuery = (q) => (!/\d/.test(q) ? q.trim() : q
  .replace(STREET_WORDS, '$1')
  .replace(/\s*,\s*/g, ', ')
  .replace(/\s{2,}/g, ' ')
  .replace(/^[\s,]+|[\s,]+$/g, ''));

/** The house number typed into an address query ("Yigal Alon 6, Beit Shemesh" -> "6"). */
export const typedNumber = (q) => (q.match(/(?:^|[\s,])(\d{1,4}[א-ת]?)(?=[\s,]|$)/u) || [])[1] || '';

// Places that are themselves somewhere to eat; picking one can fill the name.
const EATERIES = new Set(['restaurant', 'cafe', 'fast_food', 'food_court', 'ice_cream', 'bakery',
  'pastry', 'deli', 'confectionery']);

/** Photon gives some cities in two languages, "ירושלים | القدس". Keep the Hebrew. */
export function hebrewPart(s) {
  if (!s) return '';
  const parts = String(s).split(/\s*[|/]\s*/);
  return (parts.find((p) => /\p{Script=Hebrew}/u.test(p)) || parts[0]).trim();
}

const SETTLEMENTS = new Set(['city', 'town', 'village', 'hamlet']);

/**
 * The town a result is in. Around the Dead Sea and in the countryside Photon's
 * `city` is the regional council ("מועצה אזורית תמר"); the actual place --
 * עין בוקק -- is in `district`. A local council is named for its town.
 */
function townOf(p) {
  const city = hebrewPart(p.city || p.town || p.village);
  if (/^מועצה אזורית/.test(city)) return hebrewPart(p.village || p.district || p.locality) || city;
  return city.replace(/^מועצה מקומית\s+/, '');
}

/** One Photon feature -> what the form needs, or null if it isn't usable. */
export function toPlace(feature, mode = 'address') {
  const p = feature.properties || {};
  if (p.countrycode && p.countrycode !== 'IL') return null;
  const [lon, lat] = feature.geometry?.coordinates || [];

  const isSettlement = p.osm_key === 'place' && SETTLEMENTS.has(p.osm_value);
  if (mode === 'settlement') {
    if (!isSettlement || !p.name) return null;
    const name = hebrewPart(p.name);
    return { kind: 'settlement', label: name, sub: '', city: name, lat, lon };
  }
  if (isSettlement) return null; // a town belongs in the city field, not the address
  if (NOT_ADDRESSES.has(p.osm_value) || p.osm_key === 'public_transport' || p.osm_key === 'railway') return null;

  const city = townOf(p);
  const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';

  if (p.type === 'street' || (p.osm_key === 'highway' && !p.housenumber)) {
    // A street without a number: fill it in and let them type the number.
    // No coordinates -- a street's midpoint is not the restaurant.
    return { kind: 'street', address: `${p.name} `, label: p.name, sub: city, city };
  }
  if (p.osm_key === 'place' && p.osm_value === 'house') {
    return { kind: 'address', address: street, label: street, sub: city, city, lat, lon };
  }
  if (!p.name) return null;
  // A named place: a mall, a landmark, a restaurant.
  const address = [p.name, street].filter(Boolean).join(', ');
  return {
    kind: EATERIES.has(p.osm_value) ? 'eatery' : 'place',
    name: p.name,
    address,
    label: p.name,
    sub: [street, city].filter(Boolean).join(', '),
    city,
    lat,
    lon,
  };
}

/**
 * OSM has house numbers for only part of Israel (in Beit Shemesh, 186 of 476
 * streets; on שדרות יגאל אלון just number 3). When the street is found but not
 * the number typed, offer the street *with* that number -- marked as not on the
 * map, and without coordinates, so the pin is placed later like any address.
 * Exact house matches stay first.
 */
function withTypedNumber(places, n) {
  if (!n) return places;
  const exact = places.filter((p) => p.kind === 'address' && p.address.endsWith(` ${n}`));
  const numbered = places
    .filter((p) => p.kind === 'street')
    .filter((p) => !exact.some((e) => e.address === `${p.label} ${n}` && e.city === p.city))
    .map((p) => ({
      kind: 'numbered',
      address: `${p.label} ${n}`,
      label: `${p.label} ${n}`,
      sub: [p.city, window.i18n.t('places.noNumber')].filter(Boolean).join(' · '),
      city: p.city,
    }));
  const rest = places.filter((p) => !exact.includes(p) && p.kind !== 'street');
  return [...exact, ...numbered, ...rest];
}

let seq = 0;

function photonUrl(q, mode, b, limit) {
  const url = new URL(PHOTON);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('bbox', ISRAEL_BBOX);
  // OSM's own (Hebrew) names, whatever the browser's language. Without this
  // Photon follows Accept-Language, and an English browser got "Paran 9,
  // Jerusalem" instead of "פארן 9, ירושלים" -- stored that way and held.
  url.searchParams.set('lang', 'default');
  if (mode === 'settlement') {
    for (const v of SETTLEMENTS) url.searchParams.append('osm_tag', `place:${v}`);
  }
  if (b) {
    url.searchParams.set('lat', b.lat);
    url.searchParams.set('lon', b.lon);
    url.searchParams.set('zoom', '12');
  }
  return url;
}

/**
 * The Hebrew name of the settlement best matching `q` (e.g. "Bnei Brak" ->
 * "בני ברק"), or null. For a city typed in English and never picked from the list.
 */
export async function findSettlement(q) {
  try {
    const res = await fetch(photonUrl(q, 'settlement', null, 1));
    const f = (await res.json()).features?.[0];
    return f ? toPlace(f, 'settlement')?.city || null : null;
  } catch {
    return null;
  }
}

/**
 * Turns `input` into a combobox. Photon is searched in Hebrew or English and
 * always answers with OSM's own (Hebrew) names, so the stored value is Hebrew
 * whichever language was typed.
 *
 *   mode     'address' (houses, streets, named places) or 'settlement' (towns)
 *   bias()   {lat, lon} to prefer results near, or null
 *   local(q) places to list before Photon's, e.g. cities already on the map
 *   same(p)  dedupe key, so spelling variants (קרית/קריית) list once
 *   onPick(place), onType()
 */
export function attachPlaces(input, {
  mode = 'address', bias = () => null, local = () => [], same = (p) => `${p.label}|${p.sub}`,
  onPick, onType = () => {},
}) {
  const id = `places-${++seq}`;
  const list = document.createElement('ul');
  list.id = id;
  list.className = 'places';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  // Anchor the list to the input itself, not the field with its hint below.
  const anchor = document.createElement('div');
  anchor.className = 'places-anchor';
  input.replaceWith(anchor);
  anchor.append(input, list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.autocomplete = 'off';

  const cache = new Map();
  let timer = null;
  let controller = null;
  let items = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function highlight(i) {
    active = i;
    [...list.querySelectorAll('[role=option]')].forEach((el, j) => {
      el.setAttribute('aria-selected', String(j === i));
      if (j === i) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function pick(i) {
    const place = items[i];
    if (!place) return;
    close();
    onPick(place);
    // A bare street was picked: keep going, they still need the house number.
    if (place.kind === 'street') {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function render(places, loading = false) {
    items = places;
    list.replaceChildren();
    input.setAttribute('aria-busy', String(loading));
    if (!places.length && !loading) {
      close();
      return;
    }
    places.forEach((place, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const main = document.createElement('span');
      main.className = 'places-main';
      main.textContent = place.label;
      li.append(main);
      if (place.sub) {
        const sub = document.createElement('span');
        sub.className = 'places-sub';
        sub.textContent = place.sub;
        li.append(sub);
      }
      // mousedown, not click: fires before the input's blur closes the list.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(i);
      });
      list.append(li);
    });
    if (loading) {
      const wait = document.createElement('li');
      wait.className = 'places-loading';
      wait.setAttribute('aria-hidden', 'true');
      wait.textContent = window.i18n.t('places.searching');
      list.append(wait);
    }
    const credit = document.createElement('li');
    credit.className = 'places-credit';
    credit.setAttribute('aria-hidden', 'true');
    credit.textContent = window.i18n.t('places.credit');
    list.append(credit);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  async function search(q) {
    // The debounce may fire after they've moved on; then there's nothing to show.
    if (document.activeElement !== input) return;
    const typed = q;
    if (mode === 'address') q = cleanQuery(q) || q;
    const b = bias();
    const key = `${q}|${b ? `${b.lat.toFixed(2)},${b.lon.toFixed(2)}` : ''}`;
    const mine = local(q);
    if (cache.has(key)) return render(cache.get(key));
    // Show what we know at once, and that more is coming: Photon can take
    // several seconds, and an empty list reads as "nothing found".
    render(mine, true);

    controller?.abort();
    controller = new AbortController();
    try {
      const res = await fetch(photonUrl(q, mode, b, 8), { signal: controller.signal });
      if (!res.ok) throw new Error(`photon ${res.status}`);
      const data = await res.json();
      const seen = new Set(mine.map(same));
      let found = (data.features || []).map((f) => toPlace(f, mode));
      if (mode === 'address') found = withTypedNumber(found.filter(Boolean), typedNumber(q));
      const places = [...mine, ...found].filter((p, i) => {
        if (i < mine.length) return true;
        if (!p) return false;
        const k = same(p);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 6);
      cache.set(key, places);
      // Only if they're still here: a slow answer must not pop open under a
      // field they've since left.
      if (input.value.trim() === typed && document.activeElement === input) render(places);
    } catch (err) {
      // Unreachable: keep whatever we know locally, else it's a plain text box.
      if (err.name !== 'AbortError') (mine.length && document.activeElement === input ? render(mine) : close());
    }
  }

  input.addEventListener('input', () => {
    onType();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < MIN_CHARS) {
      controller?.abort();
      close();
      return;
    }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const n = items.length;
    if (!n && e.key !== 'Escape') return; // still searching
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight((active + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight((active - 1 + n) % n);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}
