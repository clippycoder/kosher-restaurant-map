/**
 * The add-a-restaurant form. The shared machinery (fields, live checks, place
 * suggestions, captcha) is in kit.js; this file adds what is particular to a
 * new restaurant: the "did you mean...?" duplicate warning, the draft kept
 * across a language switch, and sending to /api/submissions.
 */

import { FIELDS, SUBMISSION_SECTIONS, HONEYPOT } from './fields.js';
import { duplicateFlags } from './match.js';
import { API_BASE, TURNSTILE_ACTION } from './config.js';
import {
  $, el, mapData, createForm, setStatus, createCaptcha, send, explainFailure,
} from './kit.js';

const { t } = window.i18n;
const form = $('add-form');
const kit = createForm(form, FIELDS);
const captcha = createCaptcha($('submit'));

let existing = []; // [{ source, id, name, address, city, phone }], for duplicates

// --- rendering ---------------------------------------------------------------

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
    const dupes = f.key === 'name' ? [el('div', { id: 'dupes', className: 'dupes', hidden: true })] : [];
    body.append(kit.fieldBlock(f, ...dupes));
  }

  // Honeypot (the markup is in add.html); named from the shared spec.
  $('hp-input').name = HONEYPOT;
}

// --- duplicates ----------------------------------------------------------------

async function loadExisting() {
  const data = await mapData();
  existing = data.restaurants.map((r) => ({
    source: r.source === 'community' ? 'community' : 'jdn',
    id: String(r.id), name: r.name, address: r.address, city: r.city, phone: r.phone,
  }));
  try {
    const pub = await (await fetch(`${API_BASE}/api/published`)).json();
    const known = new Set(existing.map((e) => e.id));
    for (const s of pub.submissions) {
      if (!known.has(s.id)) {
        existing.push({ source: 'community', id: s.id, name: s.name, address: s.address, city: s.city, phone: s.phone });
      }
    }
  } catch {
    // The map's own list still catches most duplicates.
  }
}

let dupeTimer = null;
function warnDuplicates() {
  clearTimeout(dupeTimer);
  dupeTimer = setTimeout(() => {
    const v = kit.values();
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
      list.append(el('li', {}, el('strong', { textContent: r.name, dir: 'auto' }),
        ' — ', el('span', { textContent: [r.address, r.city].filter(Boolean).join(', '), dir: 'auto' }), ' ', link));
    }
    box.replaceChildren(
      el('p', { textContent: t('dupes.title') }),
      list,
      el('p', { className: 'muted', textContent: t('dupes.note') }),
    );
    box.hidden = false;
  }, 300);
}

// --- submitting ----------------------------------------------------------------

async function submit(e) {
  e.preventDefault();
  await kit.cityToHebrew();
  kit.touchAll();
  const errors = kit.checkAll();
  if (Object.keys(errors).length) {
    setStatus(t('st.fix'), 'error');
    kit.focusFirstError(Object.keys(errors));
    return;
  }

  const body = kit.values();
  if (!body['cf-turnstile-response']) {
    setStatus(t('st.captcha'), 'error');
    return;
  }

  const button = $('submit');
  button.disabled = true;
  setStatus(t('st.sending'));
  const res = await send('/api/submissions', body);
  if (!res) {
    button.disabled = false;
    return;
  }
  captcha.reset();
  if (res.status === 201) return done();

  button.disabled = false;
  const fields = explainFailure(res);
  if (fields) {
    for (const [k, code] of Object.entries(fields)) kit.showError(k, code);
    kit.focusFirstError(Object.keys(fields));
  }
}

// The same thanks whether it published or was held for review.
function done() {
  form.hidden = true;
  const box = $('done');
  box.querySelector('h2').textContent = t('done.title');
  box.hidden = false;
  box.querySelector('h2').focus();
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
    const draft = kit.values();
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
    const f = kit.byKey[k];
    if (!f || !v) continue;
    kit.setValue(k, v);
    if (f.section === 'advanced') $('section-advanced').open = true;
  }
}

// --- go ------------------------------------------------------------------------

render();
kit.wireCity(warnDuplicates);
kit.wireAddress((place) => {
  // A restaurant picked from the suggestions can fill the name too.
  if (place.kind === 'eatery' && !$('f-name').value.trim()) $('f-name').value = place.name;
  warnDuplicates();
});
kit.wireLiveChecks((key) => {
  if (['name', 'city', 'phone'].includes(key)) warnDuplicates();
});
keepDraftAcrossLanguageSwitch();
kit.loadCities();
loadExisting();

form.addEventListener('submit', submit);
$('again').addEventListener('click', () => location.reload());

// Last, so a captcha problem can't stop the rest of the form from working.
captcha.render(TURNSTILE_ACTION);
