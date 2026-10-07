/**
 * The add-a-restaurant form. Rendered from the shared field definitions, checked
 * as you type with the same rules the server applies, and sent to our own API.
 * Interface text comes from i18n.js (Hebrew or English); what people enter is
 * stored as entered. All text that reaches the page is set with textContent.
 */

import {
  FIELDS, SUBMISSION_SECTIONS, HONEYPOT, validate,
} from './fields.js';
import { duplicateFlags, dupKey } from './match.js';
import { attachPlaces, findSettlement } from './places.js';
import { API_BASE, TURNSTILE_SITE_KEY, TURNSTILE_ACTION } from './config.js';

const { t, choice, lang } = window.i18n;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const form = $('add-form');
const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const touched = new Set();

let existing = []; // [{ source, id, name, address, city, phone }]
let knownCities = []; // [{ name, key, lat, lon }]
let turnstileId = null;

// --- data ------------------------------------------------------------------

async function loadExisting() {
  try {
    const data = await (await fetch('data/restaurants.json')).json();
    existing = data.restaurants.map((r) => ({
      source: 'jdn', id: String(r.id), name: r.name, address: r.address, city: r.city, phone: r.phone,
    }));

    // City centres, from the restaurants already mapped there.
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
  } catch (err) {
    console.warn('restaurants.json unavailable', err);
  }
  try {
    const data = await (await fetch(`${API_BASE}/api/published`)).json();
    for (const s of data.submissions) {
      existing.push({ source: 'community', id: s.id, name: s.name, address: s.address, city: s.city, phone: s.phone });
    }
  } catch {
    // The jdn list alone still catches most duplicates.
  }
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

// --- rendering ---------------------------------------------------------------

function control(f) {
  const id = `f-${f.key}`;
  if (f.hidden) return el('input', { type: 'hidden', id, name: f.key });

  if (f.type === 'choice' && f.required && f.options.length <= 3) {
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
  if (f.type === 'textarea') return el('textarea', { id, name: f.key, maxLength: f.max, rows: 3 });

  const input = el('input', { id, name: f.key, type: 'text' });
  if (f.max) input.maxLength = f.max;
  if (f.type === 'phone') {
    Object.assign(input, { type: 'tel', inputMode: 'tel', dir: 'ltr', autocomplete: 'tel' });
  }
  if (f.type === 'url') Object.assign(input, { inputMode: 'url', dir: 'ltr', placeholder: t('placeholder.url') });
  if (f.key === 'name') input.autocomplete = 'organization';
  return input;
}

function fieldBlock(f) {
  if (f.hidden) return control(f);
  const id = `f-${f.key}`;
  const isGroup = f.type === 'choice' && f.required && f.options.length <= 3;
  const wrap = el(isGroup ? 'fieldset' : 'div', { className: 'field', id: `field-${f.key}` });
  const title = el(isGroup ? 'legend' : 'label', { textContent: t(`field.${f.key}`) });
  if (!isGroup) title.htmlFor = id;
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
  const target = isGroup ? wrap : wrap.querySelector(`#${CSS.escape(id)}`);
  target.setAttribute('aria-describedby', describedBy.join(' '));

  if (f.key === 'name') wrap.append(el('div', { id: 'dupes', className: 'dupes', hidden: true }));
  return wrap;
}

function render() {
  const main = $('section-main');
  const adv = $('section-advanced');
  main.querySelector('h2').textContent = t('section.main');
  adv.querySelector('summary').textContent = t('section.advanced');
  adv.open = !SUBMISSION_SECTIONS.advanced.collapsed;

  const note = SUBMISSION_SECTIONS.advanced.note;
  if (note) {
    const link = el('a', { href: note.link.href, textContent: t('note.link') });
    if (note.link.newTab) Object.assign(link, { target: '_blank', rel: 'noopener noreferrer' });
    adv.querySelector('.section-body').append(el('p', { className: 'note' }, t('note.text'), ' ', link));
  }

  for (const f of FIELDS) {
    const body = f.section === 'advanced' ? adv.querySelector('.section-body') : main;
    body.append(fieldBlock(f));
  }

  // Honeypot (the markup is in add.html); named from the shared spec.
  $('hp-input').name = HONEYPOT;
}

// --- values and checking -------------------------------------------------------

function values() {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = v;
  return out;
}

/** `code` is a validation code (fields.js, or the server's 422), worded here. */
function showError(key, code) {
  const f = byKey[key];
  if (!f || f.hidden) return;
  const msg = code ? t(`err.${code}`, { max: f.max }) : '';
  const id = `f-${key}`;
  const err = $(`${id}-error`);
  err.textContent = msg || '';
  err.hidden = !msg;
  const target = f.type === 'choice' && f.required && f.options.length <= 3 ? $(`field-${key}`) : $(id);
  if (msg) target.setAttribute('aria-invalid', 'true');
  else target.removeAttribute('aria-invalid');
}

function check(key) {
  const f = byKey[key];
  if (!f) return true;
  const { errors } = validate(values(), [f]);
  showError(key, errors[key]);
  return !errors[key];
}

function checkAll() {
  const { errors } = validate(values(), FIELDS);
  for (const f of FIELDS) showError(f.key, errors[f.key]);
  return errors;
}

let dupeTimer = null;
function warnDuplicates() {
  clearTimeout(dupeTimer);
  dupeTimer = setTimeout(() => {
    const v = values();
    const box = $('dupes');
    const hits = v.name && v.name.trim().length >= 2 && v.city
      ? duplicateFlags({ name: v.name, city: v.city, phone: v.phone }, existing)
      : [];
    if (!hits.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const list = el('ul');
    for (const h of hits) {
      const r = existing.find((x) => x.source === h.source && x.id === h.id) || h;
      const link = el('a', {
        href: `index.html#q=${encodeURIComponent(r.name)}`,
        target: '_blank',
        rel: 'noopener',
        textContent: t('dupes.show'),
      });
      list.append(el('li', {}, el('strong', { textContent: r.name }),
        ` — ${[r.address, r.city].filter(Boolean).join(', ')} `, link));
    }
    box.replaceChildren(
      el('p', { textContent: t('dupes.title') }),
      list,
      el('p', { className: 'muted', textContent: t('dupes.note') }),
    );
    box.hidden = false;
  }, 300);
}

// --- address suggestions -------------------------------------------------------

function setCoords(lat, lon) {
  $('f-lat').value = lat ?? '';
  $('f-lon').value = lon ?? '';
}

function wireCity() {
  const city = $('f-city');
  attachPlaces(city, {
    mode: 'settlement',
    // Cities already on the map first, matched by spelling-insensitive prefix.
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
      warnDuplicates();
    },
  });

  // Typed in English and never picked ("Bnei Brak"): store the Hebrew name the
  // map uses, and say so.
  const note = el('p', { className: 'hint', id: 'f-city-converted', hidden: true });
  $('f-city-error').before(note);
  city.addEventListener('change', () => { cityToHebrew(); });
}

/** If the city is in English, replace it with the map's Hebrew name. Awaited on submit too. */
async function cityToHebrew() {
  const city = $('f-city');
  const note = $('f-city-converted');
  const typed = city.value.trim();
  if (!/\p{Script=Latin}/u.test(typed)) return;
  note.hidden = true;
  const hebrew = await findSettlement(typed);
  if (!hebrew || city.value.trim() !== typed) return;
  city.value = canonicalCity(hebrew);
  note.textContent = t('city.converted', { city: city.value });
  note.hidden = false;
  check('city');
  warnDuplicates();
}

function wireAddress() {
  attachPlaces($('f-address'), {
    bias: () => {
      const c = knownCities.find((k) => k.name === $('f-city').value.trim());
      return c && c.lat ? { lat: c.lat, lon: c.lon } : null;
    },
    onType: () => setCoords(null, null), // retyped: the old pin no longer applies
    onPick: (place) => {
      $('f-address').value = place.address;
      if (place.city) $('f-city').value = canonicalCity(place.city);
      setCoords(place.lat, place.lon);
      if (place.kind === 'eatery' && !$('f-name').value.trim()) $('f-name').value = place.name;
      for (const k of ['address', 'city', 'name']) if (touched.has(k)) check(k);
      warnDuplicates();
    },
  });
}

// --- submitting ----------------------------------------------------------------

function setStatus(msg, kind = '') {
  const s = $('form-status');
  s.textContent = msg;
  s.className = `status ${kind}`;
  s.hidden = !msg;
}

function focusFirstError(keys) {
  const first = FIELDS.find((f) => keys.includes(f.key) && !f.hidden);
  if (!first) return;
  if (first.section === 'advanced') $('section-advanced').open = true;
  // A radio group's container can't take focus; its first option can.
  const node = $(`f-${first.key}`);
  const target = node.matches('input, select, textarea') ? node : node.querySelector('input');
  target.focus();
}

async function submit(e) {
  e.preventDefault();
  await cityToHebrew();
  FIELDS.forEach((f) => touched.add(f.key));
  const errors = checkAll();
  if (Object.keys(errors).length) {
    setStatus(t('st.fix'), 'error');
    focusFirstError(Object.keys(errors));
    return;
  }

  const body = values();
  if (!body['cf-turnstile-response']) {
    setStatus(t('st.captcha'), 'error');
    return;
  }

  const button = $('submit');
  button.disabled = true;
  setStatus(t('st.sending'));
  let res;
  let out = {};
  try {
    res = await fetch(`${API_BASE}/api/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    out = await res.json().catch(() => ({}));
  } catch {
    button.disabled = false;
    setStatus(t('st.offline'), 'error');
    return;
  }

  // Tokens are single-use: get a fresh one after every completed attempt.
  if (turnstileId !== null) window.turnstile.reset(turnstileId);
  if (res.status === 201) return done();

  button.disabled = false;
  if (res.status === 422 && out.fields) {
    for (const [k, msg] of Object.entries(out.fields)) showError(k, msg);
    focusFirstError(Object.keys(out.fields));
    setStatus(t('st.fix'), 'error');
  } else if (res.status === 429) {
    setStatus(t('st.limit'), 'error');
  } else if (res.status === 403) {
    setStatus(t('st.captchaFailed'), 'error');
  } else {
    setStatus(t('st.server'), 'error');
  }
}

// The same thanks whether it published or was held for review.
function done() {
  $('add-form').hidden = true;
  const box = $('done');
  box.querySelector('h2').textContent = t('done.title');
  box.hidden = false;
  box.querySelector('h2').focus();
}

// --- captcha -------------------------------------------------------------------

function startTurnstile() {
  if (!TURNSTILE_SITE_KEY) {
    $('submit').disabled = true;
    setStatus(t('st.notOpen'), 'info');
    return;
  }
  const started = Date.now();
  // Test for the function, not the name: until Cloudflare's script runs,
  // `window.turnstile` can be something else entirely.
  const wait = () => {
    if (typeof window.turnstile?.render === 'function') {
      turnstileId = window.turnstile.render('#captcha', {
        sitekey: TURNSTILE_SITE_KEY, action: TURNSTILE_ACTION, language: lang, size: 'flexible',
      });
    } else if (Date.now() - started < 15000) {
      setTimeout(wait, 150);
    } else {
      setStatus(t('st.captchaLoad'), 'error');
    }
  };
  wait();
}

// --- language switch --------------------------------------------------------------

/**
 * Switching language reloads the page; whatever was typed comes back. Kept in
 * sessionStorage (this tab only) and removed as soon as it's restored. The
 * captcha token and the honeypot are never kept.
 */
function keepDraftAcrossLanguageSwitch() {
  const KEY = 'add-form-draft';
  document.addEventListener('i18n:beforeswitch', () => {
    const draft = values();
    delete draft['cf-turnstile-response'];
    delete draft[HONEYPOT];
    try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* the draft is lost, not the switch */ }
  });

  let draft = null;
  try {
    draft = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    sessionStorage.removeItem(KEY);
  } catch { /* nothing to restore */ }
  if (!draft) return;
  for (const [k, v] of Object.entries(draft)) {
    const f = byKey[k];
    if (!f || !v) continue;
    const radio = form.querySelector(`input[type=radio][name="${CSS.escape(k)}"][value="${CSS.escape(v)}"]`);
    if (radio) radio.checked = true;
    else if (form.elements[k]) form.elements[k].value = v;
    if (f.section === 'advanced') $('section-advanced').open = true;
  }
}

// --- go ------------------------------------------------------------------------

render();
wireCity();
wireAddress();
keepDraftAcrossLanguageSwitch();
loadExisting();

form.addEventListener('focusout', (e) => {
  const key = e.target.name;
  if (!byKey[key]) return;
  touched.add(key);
  check(key);
});
form.addEventListener('input', (e) => {
  const key = e.target.name;
  if (touched.has(key)) check(key);
  if (['name', 'city', 'phone'].includes(key)) warnDuplicates();
});
form.addEventListener('change', (e) => {
  const key = e.target.name;
  if (e.target.type === 'radio' || e.target.tagName === 'SELECT') {
    touched.add(key);
    check(key);
  }
});
form.addEventListener('submit', submit);
$('again').addEventListener('click', () => location.reload());

// Last, so a captcha problem can't stop the rest of the form from working.
startTurnstile();
