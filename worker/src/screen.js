/**
 * Automated screening. A submission with any flag is held for review instead of
 * being published. Only the required fields are screened -- optional fields
 * can't put junk on the map's main surfaces. Phone numbers are validated, not
 * screened: a malformed one is refused outright (see fields.js).
 */

import { dupKey } from '../../public/forms/match.js';

export { dupKey, duplicateFlags } from '../../public/forms/match.js';

const SCREENED = ['name', 'address', 'city'];

const PATTERN_RULES = [
  ['link', /https?:|www\.|\.(com|net|org|info|biz|xyz|ru|io|top|shop|co\.il)\b/i],
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['repeated characters', /(.)\1{4,}/u],
  ['gibberish', /[bcdfghjklmnpqrstvwxz]{6,}/i],
  // Hebrew and Latin, plus Chinese, Japanese, Korean and Cyrillic for places
  // named in those languages. Anything else (Arabic, Greek, Thai...) is held.
  ['unusual script', new RegExp('[^' + [
    '\\p{Script=Hebrew}', '\\p{Script=Latin}', '\\p{Script=Cyrillic}',
    '\\p{Script=Han}', '\\p{Script=Hiragana}', '\\p{Script=Katakana}', '\\p{Script=Hangul}',
    '\\p{N}', '\\p{P}', '\\p{Zs}', '\\p{S}', '\\p{M}', '\\u30FC', // ー, the katakana long-vowel mark
  ].join('') + ']', 'u')],
];

/**
 * Whole words only. Text is split into words on anything that isn't a letter or
 * digit, so "sex" never matches "Essex" and a phrase must appear word for word.
 *
 * Hebrew prefixes (ו/ה/ב/ל/מ/ש/כ) are deliberately NOT stripped: doing so turns
 * ordinary words into listed ones -- מזונות (food, and a bracha) minus its מ is
 * a slur. Common prefixed forms are listed explicitly instead.
 *
 * Words that are ordinary in other senses are left out on purpose: כוס (cup),
 * תחת (under), זין (weapon), ליווי alone (accompaniment), cock (cocktail bars).
 */
const WORDS = {
  spam: [
    'casino', 'casinos', 'viagra', 'cialis', 'crypto', 'bitcoin', 'loan', 'loans', 'porn', 'porno',
    'xxx', 'sex', 'betting', 'bet365', 'forex', 'seo', 'escort', 'escorts', 'onlyfans', 'nude',
    'nudes', 'hookup', 'dating', 'replica', 'click here', 'free money', 'work from home',
    'קזינו', 'הימורים', 'הימור', 'הלוואה', 'הלוואות', 'סקס', 'פורנו', 'ביטקוין', 'קריפטו',
    'פורקס', 'דיסקרטי', 'דיסקרטית', 'דיסקרטיות', 'נערות ליווי', 'נערת ליווי', 'ליווי דיסקרטי',
    'היכרויות', 'הכרויות',
  ],
  offensive: [
    'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'asshole',
    'dick', 'pussy', 'nigger', 'nigga', 'faggot', 'fag', 'whore', 'slut', 'retard', 'kike',
    'wanker', 'twat',
    'זונה', 'הזונה', 'זונות', 'שרמוטה', 'שרמוטות', 'מניאק', 'מניאקים', 'חרא', 'חארות',
    'קוקסינל', 'כושי', 'כושים', 'ערבוש', 'ערבושים', 'מזדיין', 'מזדיינת', 'לזיין', 'זיון',
    'תזדיין', 'דביל', 'מפגר', 'מפגרים', 'אידיוט', 'נאצי', 'נאצים', 'ימח שמו', 'יימח שמו',
  ],
};

const wordsOf = (s) => String(s || '').toLowerCase().normalize('NFC')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function listedWord(text) {
  const padded = ` ${wordsOf(text).join(' ')} `;
  for (const [reason, list] of Object.entries(WORDS)) {
    if (list.some((w) => padded.includes(` ${w} `))) return reason === 'spam' ? 'spam word' : 'offensive word';
  }
  return null;
}

/**
 * An address that can't be one: just the restaurant's name, just the city, or
 * the two together. None of the 641 live addresses do this; plenty are mall or
 * landmark names without a number, so "no house number" is not a rule.
 */
function badAddress(data) {
  const a = dupKey(data.address);
  const n = dupKey(data.name);
  const c = dupKey(data.city);
  if (!a) return null;
  if (n && a === n) return 'address is the name';
  if (c && a === c) return 'address is only the city';
  if (n && c && (a === n + c || a === c + n)) return 'address is the name and city';
  return null;
}

// Screens whichever of the required fields are present: all of them for a new
// restaurant, only the changed ones for an edit.
export function spamFlags(data) {
  const flags = [];
  for (const field of SCREENED.filter((f) => f in data)) {
    const v = data[field] || '';
    if (!/\p{L}/u.test(v)) flags.push({ kind: 'spam', field, reason: 'no letters' });
    for (const [reason, re] of PATTERN_RULES) {
      if (re.test(v)) flags.push({ kind: 'spam', field, reason });
    }
    const word = listedWord(v);
    if (word) flags.push({ kind: 'spam', field, reason: word });
  }
  if ('address' in data && 'name' in data) {
    const reason = badAddress(data);
    if (reason) flags.push({ kind: 'spam', field: 'address', reason });
  }
  return flags;
}

