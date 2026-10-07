/**
 * Update or report a restaurant: update.html?id=<id>, opened from a popup.
 *
 *   It has closed                     -> report (kind "closed")
 *   Some details are wrong / missing  -> a correction form with the current
 *                                        details filled in -- the same for a
 *                                        בהשגחה listing and one of ours. Only
 *                                        changed fields are sent (/api/edits);
 *                                        each is accepted once two different
 *                                        people send the same value, or by the
 *                                        moderator.
 *   (A misplaced pin is corrected through the address, under "details".)
 *   Something else                    -> report (kind "other"), text required
 *
 * Reports never change anything by themselves; they go to the moderator.
 */

import { FIELDS, EDIT_FIELDS, REPORT_FIELDS, HONEYPOT, sameValue } from './fields.js';
import { TURNSTILE_ACTIONS } from './config.js';
import {
  $, el, mapData, createForm, setStatus, createCaptcha, send, explainFailure,
} from './kit.js';

const { t } = window.i18n;
const form = $('update-form');

// The correction form: every editable field, none required (send only what changes).
const EDITS = EDIT_FIELDS.filter((f) => f.key !== 'restaurant');
const DETAILS = REPORT_FIELDS.find((f) => f.key === 'details');
const kit = createForm(form, [...EDITS, DETAILS]);
const captcha = createCaptcha($('submit'));

const KINDS = ['closed', 'details', 'other'];
let restaurant = null;  // the record from the map's data
let original = {};      // its current values, in form-field terms
// Every listing takes corrections field by field (a בהשגחה one into its shadow
// listing, one of ours directly); kept as a switch in case a kind ever can't.
let canEdit = true;

// A record from the map in the form's field names (the map calls hechsher "kashrut").
const asFields = (r) => ({
  name: r.name, address: r.address, city: r.city, type: r.type, hechsher: r.kashrut, phone: r.phone,
  description: r.description, whatsapp: r.whatsapp, website: r.website, hours: r.hours,
  delivery: r.delivery, accessible: r.accessible, reservation: r.reservation,
});

// --- rendering ---------------------------------------------------------------

function showCurrent(r) {
  $('current-name').textContent = r.name;
  $('current-name').dir = 'auto';
  const dl = $('current-details');
  const row = (label, value) => {
    if (!value) return;
    dl.append(el('dt', { textContent: label }), el('dd', { textContent: value, dir: 'auto' }));
  };
  row(t('pop.address'), [r.address, r.city].filter(Boolean).join(', '));
  row(t('pop.kashrut'), r.kashrut);
  row(t('pop.type'), r.type);
  row(t('pop.phone'), r.phone);
  row(t('pop.hours'), r.hours);
  if (r.source === 'community') {
    $('current-name').after(el('p', { className: 'badge', textContent: t('pop.community') }));
  }
  $('current').hidden = false;
}

function render() {
  for (const kind of KINDS) {
    const id = `kind-${kind}`;
    const radio = el('input', { type: 'radio', name: 'kind', value: kind, id });
    $('kinds').append(el('label', { className: 'pill', htmlFor: id }, radio,
      el('span', { textContent: t(`update.kind.${kind}`) })));
  }

  if (canEdit) {
    const main = $('edit-main');
    const adv = $('section-advanced').querySelector('.section-body');
    for (const f of EDITS) (f.section === 'advanced' ? adv : main).append(kit.fieldBlock(f));
    for (const [k, v] of Object.entries(original)) if (v) kit.setValue(k, v);
  }
  $('section-details').append(kit.fieldBlock(DETAILS));
  $('hp-input').name = HONEYPOT;
}

/** Shows the part of the form the chosen kind needs, and the matching captcha. */
function setMode(kind) {
  const correcting = kind === 'details' && canEdit;
  $('section-edit').hidden = !correcting;
  $('section-details').hidden = correcting;

  // The details box: required where it is the whole message.
  const label = $('field-details').querySelector('label');
  const required = kind === 'other' || (kind === 'details' && !canEdit);
  label.textContent = t(required ? 'update.details.required' : 'update.details.optional');
  if (required) label.append(el('span', { className: 'req', textContent: ' *', title: t('required') }));
  kit.showError('details', null);

  setStatus('');
  $('submit').disabled = false;
  captcha.render(correcting ? TURNSTILE_ACTIONS.edit : TURNSTILE_ACTIONS.report);
}

// --- submitting ----------------------------------------------------------------

/** The correction as the server wants it: only fields whose value changed. */
function changedFields() {
  const v = kit.values();
  const out = {};
  for (const f of EDITS) {
    const now = (v[f.key] ?? '').trim();
    if (!now) continue; // the server can't clear a field; empty means "leave it"
    if (f.private || !sameValue(f.key, now, original[f.key] ?? '')) out[f.key] = now;
  }
  // Private fields alone (e.g. "your relation to the place") change nothing.
  return Object.keys(out).some((k) => !EDITS.find((f) => f.key === k).private) ? out : null;
}

async function submit(e) {
  e.preventDefault();
  const kind = new FormData(form).get('kind');
  if (!kind) {
    setStatus(t('st.chooseKind'), 'error');
    return;
  }
  const correcting = kind === 'details' && canEdit;

  if (correcting) await kit.cityToHebrew();
  kit.touchAll();
  const errors = kit.checkAll();
  if (Object.keys(errors).length) {
    setStatus(t('st.fix'), 'error');
    kit.focusFirstError(Object.keys(errors));
    return;
  }

  const all = kit.values();
  const token = all['cf-turnstile-response'];
  let path;
  let body;
  if (correcting) {
    const changes = changedFields();
    if (!changes) {
      setStatus(t('st.noChanges'), 'error');
      return;
    }
    path = '/api/edits';
    body = { restaurant: String(restaurant.id), ...changes };
  } else {
    path = '/api/reports';
    body = { restaurant: String(restaurant.id), kind, details: all.details || '' };
  }
  if (!token) {
    setStatus(t('st.captcha'), 'error');
    return;
  }
  body['cf-turnstile-response'] = token;
  body[HONEYPOT] = all[HONEYPOT] || '';

  const button = $('submit');
  button.disabled = true;
  setStatus(t('st.sending'));
  const res = await send(path, body);
  if (!res) {
    button.disabled = false;
    return;
  }
  captcha.reset();
  if (res.status === 201) {
    form.hidden = true;
    $('done').hidden = false;
    $('done').querySelector('h2').focus();
    return;
  }
  button.disabled = false;
  const fields = explainFailure(res);
  if (fields) {
    for (const [k, code] of Object.entries(fields)) kit.showError(k, code);
    kit.focusFirstError(Object.keys(fields));
  }
}

// --- go ------------------------------------------------------------------------

async function start() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const data = await mapData();
  restaurant = data.restaurants.find((r) => String(r.id) === id) || null;
  if (!restaurant) {
    $('missing').hidden = false;
    return;
  }
  original = asFields(restaurant);

  showCurrent(restaurant);
  render();
  if (canEdit) {
    kit.wireCity();
    kit.wireAddress();
    kit.loadCities();
  }
  kit.wireLiveChecks();
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') setMode(e.target.value); });
  form.addEventListener('submit', submit);
  form.hidden = false;
}

start();
