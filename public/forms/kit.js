/**
 * What the site's forms share: rendering fields from the shared definitions,
 * checking them as people type (the same rules the server applies), address and
 * city suggestions that store places in Hebrew, the captcha, and sending.
 *
 * Interface text comes from i18n.js; what people enter is stored as entered.
 * All text that reaches the page is set with textContent.
 */

import { validate } from './fields.js';
import { dupKey } from './match.js';
import { attachPlaces, findSettlement } from './places.js';
import { API_BASE, TURNSTILE_SITE_KEY } from './config.js';

const { t, choice, lang } = window.i18n;

export const $ = (id) => document.getElementById(id);
export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/** The map's data, fetched once per page. */
let dataPromise = null;
export const mapData = () => {
  dataPromise ||= fetch('data/restaurants.json').then((r) => r.json()).catch((err) => {
    console.warn('restaurants.json unavailable', err);
    return { restaurants: [], facets: { cities: [] } };
  });
  return dataPromise;
};

const isPills = (f) => f.type === 'choice' && f.required && f.options.length <= 3;

/**
 * Binds a <form> to a list of field definitions. Returns the helpers its page
 * needs; the page decides what to render where and what to send.
 */
export function createForm(form, fields) {
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const touched = new Set();
  let knownCities = []; // [{ name, key, lat, lon }]

  // --- rendering ---------------------------------------------------------------

  function control(f) {
    const id = `f-${f.key}`;
    if (f.hidden) return el('input', { type: 'hidden', id, name: f.key });

    if (isPills(f)) {
      const group = el('div', { className: 'pills', id, role: 'radiogroup' });
      for (const opt of f.options) {
        const radio = el('input', { type: 'radio', name: f.key, value: opt, id: `${id}-${opt}` });
        // Restaurant information (בשרי/חלבי/פרווה) is shown as stored, in Hebrew.
        group.append(el('label', { className: 'pill', htmlFor: radio.id }, radio, el('span', { textContent: opt })));
      }
      return group;
    }
    if (f.type === 'choice') {
      const select = el('select', { id, name: f.key });
      select.append(el('option', { value: '', textContent: f.required ? t('choose') : t('unknown') }));
      // Hechsherim are restaurant information and stay Hebrew; only the form's
      // own answers (yes/no, relation to the place) are translated.
      for (const opt of f.options) select.append(el('option', { value: opt, textContent: choice(opt) }));
      return select;
    }
    // What people type reads in its own direction (i18n.followTypedDirection).
    if (f.type === 'textarea') {
      const area = el('textarea', { id, name: f.key, maxLength: f.max, rows: 3 });
      window.i18n.followTypedDirection(area);
      return area;
    }

    const input = el('input', { id, name: f.key, type: 'text' });
    if (f.max) input.maxLength = f.max;
    if (f.type === 'phone') {
      Object.assign(input, { type: 'tel', inputMode: 'tel', dir: 'ltr', autocomplete: 'tel' });
    }
    if (f.type === 'url') Object.assign(input, { inputMode: 'url', dir: 'ltr', placeholder: t('placeholder.url') });
    if (f.key === 'name') input.autocomplete = 'organization';
    if (!input.dir) window.i18n.followTypedDirection(input); // phones and links stay LTR
    return input;
  }

  /** A field with its label, hints and error line. `extra` nodes go at the end. */
  function fieldBlock(f, ...extra) {
    if (f.hidden) return control(f);
    const id = `f-${f.key}`;
    const group = isPills(f);
    const wrap = el(group ? 'fieldset' : 'div', { className: 'field', id: `field-${f.key}` });
    const title = el(group ? 'legend' : 'label', { textContent: t(`field.${f.key}`) });
    if (!group) title.htmlFor = id;
    if (f.required) title.append(el('span', { className: 'req', textContent: ' *', title: t('required') }));
    if (f.private) title.append(el('span', { className: 'private', textContent: t('private') }));
    wrap.append(title, control(f));

    const describedBy = [];
    if (f.type === 'phone') {
      const hint = el('p', { className: 'hint', id: `${id}-hint`, textContent: t('hint.phone') });
      wrap.append(hint);
      describedBy.push(hint.id);
    }
    // In English: say that places are kept in Hebrew, as the map shows them.
    if ((f.key === 'address' || f.key === 'city') && t('hint.hebrew')) {
      const hint = el('p', { className: 'hint', id: `${id}-lang`, textContent: t('hint.hebrew') });
      wrap.append(hint);
      describedBy.push(hint.id);
    }
    const err = el('p', { className: 'field-error', id: `${id}-error`, hidden: true });
    wrap.append(err);
    describedBy.push(err.id);
    (group ? wrap : wrap.querySelector(`#${CSS.escape(id)}`)).setAttribute('aria-describedby', describedBy.join(' '));
    wrap.append(...extra);
    return wrap;
  }

  // --- values and checking -------------------------------------------------------

  function values() {
    const out = {};
    for (const [k, v] of new FormData(form)) out[k] = v;
    return out;
  }

  /** Sets a field's value, whichever kind of control it is. */
  function setValue(key, v) {
    const radio = form.querySelector(`input[type=radio][name="${CSS.escape(key)}"][value="${CSS.escape(v)}"]`);
    if (radio) radio.checked = true;
    else if (form.elements[key]) {
      form.elements[key].value = v;
      form.elements[key].dispatchEvent(new Event('change')); // let its direction follow
    }
  }

  /** `code` is a validation code (fields.js, or the server's 422), worded here. */
  function showError(key, code) {
    const f = byKey[key];
    if (!f || f.hidden || !$(`f-${key}-error`)) return;
    const msg = code ? t(`err.${code}`, { max: f.max }) : '';
    const err = $(`f-${key}-error`);
    err.textContent = msg;
    err.hidden = !msg;
    const target = isPills(f) ? $(`field-${key}`) : $(`f-${key}`);
    if (msg) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
  }

  // On the page, and not tucked away in a mode that isn't showing.
  const visible = (f) => {
    const node = $(`f-${f.key}`);
    return !!node && !node.closest('[hidden]');
  };

  function check(key) {
    const f = byKey[key];
    if (!f) return true;
    const { errors } = validate(values(), [f]);
    showError(key, errors[key]);
    return !errors[key];
  }

  /** Checks every field that is on the page (not hidden away in another mode). */
  function checkAll(only = fields) {
    const list = only.filter(visible);
    const { errors } = validate(values(), list);
    for (const f of list) showError(f.key, errors[f.key]);
    return errors;
  }

  function focusFirstError(keys) {
    const first = fields.find((f) => keys.includes(f.key) && !f.hidden);
    if (!first) return;
    const details = $(`f-${first.key}`)?.closest('details');
    if (details) details.open = true;
    // A radio group's container can't take focus; its first option can.
    const node = $(`f-${first.key}`);
    if (!node) return;
    (node.matches('input, select, textarea') ? node : node.querySelector('input')).focus();
  }

  /** Live checks: a field is checked once left, and then on every change. */
  function wireLiveChecks(onInput = () => {}) {
    form.addEventListener('focusout', (e) => {
      const key = e.target.name;
      if (!byKey[key]) return;
      touched.add(key);
      check(key);
    });
    form.addEventListener('input', (e) => {
      const key = e.target.name;
      if (touched.has(key)) check(key);
      onInput(key);
    });
    form.addEventListener('change', (e) => {
      const key = e.target.name;
      if (byKey[key] && (e.target.type === 'radio' || e.target.tagName === 'SELECT')) {
        touched.add(key);
        check(key);
      }
    });
  }

  const touchAll = () => fields.forEach((f) => touched.add(f.key));

  // --- places ------------------------------------------------------------------

  /** Cities on the map, with their centres (for biasing suggestions). */
  async function loadCities() {
    const data = await mapData();
    const sums = new Map();
    for (const r of data.restaurants) {
      if (!r.city || r.lat == null) continue;
      const s = sums.get(r.city) || { lat: 0, lon: 0, n: 0 };
      s.lat += r.lat;
      s.lon += r.lon;
      s.n += 1;
      sums.set(r.city, s);
    }
    knownCities = data.facets.cities.map((c) => {
      const s = sums.get(c.name);
      return { name: c.name, key: dupKey(c.name), lat: s && s.lat / s.n, lon: s && s.lon / s.n };
    });
  }

  /**
   * Photon's city name -> the map's spelling of it, so the city filter doesn't
   * split ("תל אביב–יפו" -> "תל אביב"). Exact match first, then the longest known
   * city the name starts with; otherwise Photon's name as given.
   */
  function canonicalCity(name) {
    const key = dupKey(name);
    if (!key) return name;
    const exact = knownCities.find((c) => c.key === key);
    if (exact) return exact.name;
    const prefix = knownCities
      .filter((c) => c.key.length >= 3 && key.startsWith(c.key))
      .sort((a, b) => b.key.length - a.key.length)[0];
    return prefix ? prefix.name : name;
  }

  function setCoords(lat, lon) {
    if ($('f-lat')) $('f-lat').value = lat ?? '';
    if ($('f-lon')) $('f-lon').value = lon ?? '';
  }

  /** City suggestions: the map's cities first, then Photon's towns, all in Hebrew. */
  function wireCity(onChange = () => {}) {
    const city = $('f-city');
    attachPlaces(city, {
      mode: 'settlement',
      local: (q) => {
        const k = dupKey(q);
        return knownCities
          .filter((c) => c.key.startsWith(k) || c.key.includes(k))
          .slice(0, 5)
          .map((c) => ({ kind: 'settlement', label: c.name, sub: '', city: c.name }));
      },
      same: (p) => dupKey(canonicalCity(p.label)),
      onPick: (place) => {
        city.value = canonicalCity(place.city);
        if (touched.has('city')) check('city');
        onChange();
      },
    });
    // Typed in English and never picked ("Bnei Brak"): store the Hebrew name
    // the map uses, and say so.
    const note = el('p', { className: 'hint', id: 'f-city-converted', hidden: true });
    $('f-city-error').before(note);
    city.addEventListener('change', () => { cityToHebrew().then(onChange); });
  }

  /** If the city is in English, replace it with the map's Hebrew name. Awaited before sending. */
  async function cityToHebrew() {
    const city = $('f-city');
    const note = $('f-city-converted');
    if (!city || !note) return;
    const typed = city.value.trim();
    if (!/\p{Script=Latin}/u.test(typed)) return;
    note.hidden = true;
    const hebrew = await findSettlement(typed);
    if (!hebrew || city.value.trim() !== typed) return;
    city.value = canonicalCity(hebrew);
    note.textContent = t('city.converted', { city: city.value });
    note.hidden = false;
    check('city');
  }

  /** Address suggestions; picking one fills the city and, for exact places, coordinates. */
  function wireAddress(onPick = () => {}) {
    attachPlaces($('f-address'), {
      bias: () => {
        const c = knownCities.find((k) => k.name === $('f-city').value.trim());
        return c && c.lat ? { lat: c.lat, lon: c.lon } : null;
      },
      onType: () => setCoords(null, null), // retyped: the old pin no longer applies
      onPick: (place) => {
        $('f-address').value = place.address;
        if (place.city) $('f-city').value = canonicalCity(place.city);
        for (const k of ['address', 'city']) $(`f-${k}`).dispatchEvent(new Event('change'));
        setCoords(place.lat, place.lon);
        for (const k of ['address', 'city']) if (touched.has(k)) check(k);
        onPick(place);
      },
    });
  }

  return {
    byKey, control, fieldBlock, values, setValue, showError, check, checkAll, focusFirstError,
    wireLiveChecks, touchAll, loadCities, canonicalCity, wireCity, cityToHebrew, wireAddress,
  };
}

// --- status, captcha, sending -------------------------------------------------------

export function setStatus(msg, kind = '') {
  const s = $('form-status');
  s.textContent = msg;
  s.className = `status ${kind}`;
  s.hidden = !msg;
}

/**
 * The Turnstile widget in #captcha. Each form type has its own action, which
 * the worker checks; `render(action)` replaces the widget when it changes.
 */
export function createCaptcha(button) {
  let id = null;
  let current = null;

  function whenReady(fn) {
    const started = Date.now();
    // Test for the function, not the name: until Cloudflare's script runs,
    // `window.turnstile` can be something else entirely.
    const wait = () => {
      if (typeof window.turnstile?.render === 'function') fn(window.turnstile);
      else if (Date.now() - started < 15000) setTimeout(wait, 150);
      else setStatus(t('st.captchaLoad'), 'error');
    };
    wait();
  }

  return {
    render(action) {
      if (!TURNSTILE_SITE_KEY) {
        button.disabled = true;
        setStatus(t('st.notOpen'), 'info');
        return;
      }
      if (action === current) return;
      current = action;
      whenReady((ts) => {
        if (id !== null) ts.remove(id);
        id = ts.render('#captcha', { sitekey: TURNSTILE_SITE_KEY, action, language: lang, size: 'flexible' });
      });
    },
    // Tokens are single-use: get a fresh one after every completed attempt.
    reset() {
      if (id !== null) window.turnstile.reset(id);
    },
  };
}

/**
 * POSTs to the worker. Returns { status, out }, or null when the server can't
 * be reached (the status line already says so).
 */
export async function send(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, out: await res.json().catch(() => ({})) };
  } catch {
    setStatus(t('st.offline'), 'error');
    return null;
  }
}

/** Words a failed response; returns the field errors of a 422, if any. */
export function explainFailure({ status, out }) {
  if (status === 422 && out.fields) {
    setStatus(t('st.fix'), 'error');
    return out.fields;
  }
  if (status === 422 && out.error === 'no changes') setStatus(t('st.noChanges'), 'error');
  else if (status === 429) setStatus(t('st.limit'), 'error');
  else if (status === 403) setStatus(t('st.captchaFailed'), 'error');
  else setStatus(t('st.server'), 'error');
  return null;
}
