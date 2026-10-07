/**
 * The forms, as data and validation. This one file is loaded by the page (as an
 * ES module, to check fields as people type and block a bad submit) and bundled
 * into the worker (to check them again on arrival), so the two can't disagree.
 * Keep it dependency-free and browser-safe.
 *
 * Modelled on rest.jdn.co.il/add-res-2 (their form_fields[...] names noted per
 * field). Fields used by the map and its filters are required and sit in the
 * `main` section; everything else is optional, under `advanced`.
 *
 * `private: true` fields are stored apart from the rest and are only ever
 * returned to the moderator. Changing a field here needs no migration --
 * submissions are stored as JSON.
 */

export const TYPES = ['בשרי', 'חלבי', 'פרווה'];

// jdn's dropdown, verbatim. Fixed list, no free text, so the filter stays tidy.
export const HECHSHERIM = [
  'בד"צ אגודת ישראל', 'בד״ץ העדה״ח ירושלים', 'בית יוסף', 'הרב לנדא', 'הרב מחפוד',
  'הרב רובין', 'חוג חת״ס ב״ב', 'חתם סופר פ״ת', 'מחזיקי הדת בעלזא', 'קהילות',
  'רבנות ירושלים מהדרין', 'רבנות מהדרין', 'רבני הקריות - אשדוד',
];

const YES_NO = ['כן', 'לא'];

// בהשגחה's own add form. Offered as an alternative inside "advanced".
export const JDN_ADD_URL = 'https://rest.jdn.co.il/add-res-2/';

/**
 * How the add form groups its fields. `advanced` starts collapsed; opening it
 * also shows the note, which offers בהשגחה's own form instead of ours.
 */
export const SUBMISSION_SECTIONS = {
  main: { label: 'פרטי המסעדה' },
  advanced: {
    label: 'פרטים נוספים (לא חובה)',
    collapsed: true,
    note: {
      text: 'אפשר להגיש את המסעדה גם ישירות לאתר בהשגחה. ' +
        'הגשות שם עוברות אישור של צוות האתר, ולכן עשוי לעבור זמן עד שהמסעדה תופיע.',
      link: { label: 'להגשה באתר בהשגחה', href: JDN_ADD_URL, newTab: true },
    },
  },
};

export const FIELDS = [
  // main -- everything the map shows or filters on
  { key: 'name', label: 'שם המסעדה', type: 'text', required: true, max: 120, section: 'main' },  // resname
  { key: 'address', label: 'כתובת', type: 'text', required: true, max: 200, section: 'main' },   // address
  // jdn has no city field. Region is derived from the city at build time.
  { key: 'city', label: 'עיר', type: 'text', required: true, max: 60, section: 'main' },
  { key: 'type', label: 'בשרי / חלבי / פרווה', type: 'choice', options: TYPES, required: true, section: 'main' },
  { key: 'hechsher', label: 'כשרות', type: 'choice', options: HECHSHERIM, required: true, section: 'main' },
  { key: 'phone', label: 'טלפון', type: 'phone', required: true, section: 'main' },              // tel

  // advanced -- optional
  { key: 'description', label: 'תיאור קצר', type: 'text', max: 300, section: 'advanced' },       // shortdes
  { key: 'whatsapp', label: 'וואטסאפ', type: 'phone', section: 'advanced' },                      // whatsapp
  { key: 'website', label: 'אתר / אינסטגרם', type: 'url', max: 300, section: 'advanced' },
  { key: 'hours', label: 'שעות פתיחה', type: 'text', max: 200, section: 'advanced' },
  { key: 'delivery', label: 'יש משלוחים?', type: 'choice', options: YES_NO, section: 'advanced' },        // delivery
  { key: 'accessible', label: 'המקום נגיש?', type: 'choice', options: YES_NO, section: 'advanced' },      // (jdn reuses "delivery")
  { key: 'reservation', label: 'חובה להזמין מקום?', type: 'choice', options: YES_NO, section: 'advanced' }, // order
  // Filled in when an address suggestion is picked; cleared if the address is
  // then retyped. Lets the build place the pin without geocoding.
  { key: 'lat', type: 'coord', range: [29.4, 33.4], hidden: true, editable: false, section: 'main' },
  { key: 'lon', type: 'coord', range: [34.2, 35.95], hidden: true, editable: false, section: 'main' },
  { key: 'submitterRole', label: 'הקשר שלך למקום', type: 'choice', options: ['בעלים / צוות', 'לקוח', 'אחר'],
    private: true, section: 'advanced' },
  { key: 'ownerPhone', label: 'טלפון בעלים', type: 'phone', private: true, section: 'advanced' },     // mashgiach (sic)
  { key: 'mashgiachPhone', label: 'טלפון משגיח', type: 'phone', private: true, section: 'advanced' }, // mashgiach (dup name)
];

export const REPORT_KINDS = {
  closed: 'המקום נסגר',
  details: 'פרטים שגויים',
  location: 'מיקום שגוי במפה',
  kashrut: 'הכשרות השתנתה',
  other: 'אחר',
};

export const REPORT_FIELDS = [
  // jdn post id, or "c<id>" for one of ours.
  { key: 'restaurant', label: 'מסעדה', type: 'ref', pattern: '^c?\\d{1,9}$', required: true },
  { key: 'kind', label: 'מה הבעיה?', type: 'choice', options: Object.keys(REPORT_KINDS), required: true },
  { key: 'details', label: 'פרטים', type: 'textarea', max: 1000, requiredWhen: { kind: ['details', 'other'] } },
];

/**
 * An edit of a jdn restaurant: the same fields as a new submission, all
 * optional, sent with only what changes. Each changed field is accepted once a
 * second, different person submits the same value, or the moderator approves it.
 */
export const EDIT_FIELDS = [
  { key: 'restaurant', label: 'מסעדה', type: 'ref', pattern: '^\\d{1,9}$', required: true },
  ...FIELDS.filter((f) => f.editable !== false).map(({ required, ...f }) => f),
];

// The fields an edit can change, i.e. everything public.
export const EDITABLE = FIELDS.filter((f) => !f.private && f.editable !== false).map((f) => f.key);

/** Two values are "the same info" if they differ only in case, spacing or punctuation. */
export const matchKey = (v) => String(v ?? '')
  .toLowerCase()
  .normalize('NFC')
  // Includes the Hebrew maqaf (־) and the other dash variants.
  .replace(/[\s"'`׳״‘’“”\-‐‑‒–—―−־.,:;!?()/|]/g, '');

// Bot trap: a field humans never see. Anything in it means the post is dropped.
export const HONEYPOT = 'company';

const clean = (v) => String(v ?? '')
  .normalize('NFC')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  // Invisible direction marks and embeddings: pasted Hebrew/English text is full
  // of them, and they can reorder how a name displays.
  .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
  .replace(/\r\n?/g, '\n');

/**
 * Accepts:
 *   Israeli numbers in any common spelling   02-5377000, 054 123 4567, +972-54-1234567
 *   national numbers                         1-700-50-60-70, 1-800-...
 *   star numbers, star on either side        *2242, 2242*  (typed RTL, the star lands after)
 *   an extension                             077-7000333 שלוחה 6, ... ext 6
 *   foreign numbers in international form    +1 212 555 0100
 *
 * Returns the number in one canonical form (Israeli numbers as local digits,
 * so duplicates compare equal), or null when it isn't a phone number. Against
 * the live map this rejects exactly jdn's 4 typos: a digit too many or too few.
 */
export function normalizePhone(raw) {
  let s = clean(raw).trim();
  let ext = '';
  const m = s.match(/\s*(?:שלוחה|שלוח׳|שלוח'|ext\.?|x)\s*(\d{1,5})\s*$/i);
  if (m) {
    ext = m[1];
    s = s.slice(0, m.index);
  }

  let d = s.replace(/[\s\-–‐‑().\u200E\u200F]/g, '');
  if (/^\d{4}\*$/.test(d)) d = `*${d.slice(0, 4)}`;
  if (d.startsWith('00')) d = `+${d.slice(2)}`;
  if (d.startsWith('+972')) d = `0${d.slice(4)}`;
  else if (/^972\d{8,9}$/.test(d)) d = `0${d.slice(3)}`;

  const ok = /^0\d{8,9}$/.test(d) || /^1[5-9]00\d{6}$/.test(d) || /^\*\d{4}$/.test(d) ||
    /^\+[1-9]\d{6,14}$/.test(d);
  if (!ok) return null;
  return ext ? `${d} שלוחה ${ext}` : d;
}

/** The number alone, without any extension, for comparing two phones. */
export const phoneKey = (p) => (normalizePhone(p) || '').split(' ')[0];

// Each number sits in a left-to-right isolate (U+2066...U+2069); without them
// an RTL sentence reorders the digits and commas around each other.
const PHONE_EXAMPLES = ['02-5377000', '054-1234567', '1-700-500-500', '*2242'];
const ltr = (s) => `\u2066${s}\u2069`;
export const PHONE_HINT = `לדוגמה ${PHONE_EXAMPLES.slice(0, -1).map(ltr).join(', ')} או ${ltr(PHONE_EXAMPLES.at(-1))}`;

function normalizeUrl(raw) {
  let s = clean(raw).trim();
  if (/^@[\w.]{1,30}$/.test(s)) s = `https://instagram.com/${s.slice(1)}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Returns { public, private, errors }. `errors` maps field key -> Hebrew message.
 * Unknown keys are ignored rather than stored, so a client cannot smuggle
 * arbitrary data into the database.
 */
export function validate(input, fields = FIELDS) {
  const out = { public: {}, private: {}, errors: {} };
  const values = {};
  for (const f of fields) {
    const raw = clean(input?.[f.key]);
    values[f.key] = f.type === 'textarea' ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
  }

  for (const f of fields) {
    const v = values[f.key];
    const required = f.required || (f.requiredWhen && Object.entries(f.requiredWhen)
      .every(([k, want]) => [].concat(want).includes(values[k])));

    if (!v) {
      if (required) out.errors[f.key] = 'שדה חובה';
      continue;
    }
    if (f.max && v.length > f.max) {
      out.errors[f.key] = `עד ${f.max} תווים`;
      continue;
    }

    let stored = v;
    if (f.type === 'choice' && !f.options.includes(v)) stored = null;
    if (f.type === 'phone') stored = normalizePhone(v);
    if (f.type === 'url') stored = normalizeUrl(v);
    if (f.type === 'ref') stored = new RegExp(f.pattern).test(v) ? v : null;
    if (f.type === 'coord') {
      const n = Number(v);
      stored = Number.isFinite(n) && n >= f.range[0] && n <= f.range[1] ? Math.round(n * 1e6) / 1e6 : null;
    }
    if (stored === null) {
      // The form shows PHONE_HINT under every phone field, so the error stays short.
      out.errors[f.key] = f.type === 'phone' ? 'מספר טלפון לא תקין' : 'ערך לא חוקי';
      continue;
    }
    (f.private ? out.private : out.public)[f.key] = stored;
  }
  return out;
}

/** The spec as the browser needs it -- labels, types, options, limits, sections. */
export const publicSpec = () => ({
  submission: FIELDS,
  submissionSections: SUBMISSION_SECTIONS,
  report: REPORT_FIELDS,
  edit: EDIT_FIELDS,
  reportKinds: REPORT_KINDS,
  honeypot: HONEYPOT,
});
