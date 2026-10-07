/**
 * Duplicate matching, shared by the page (to warn "did you mean...?" while the
 * name is typed) and the worker (to hold a likely duplicate for review).
 */

import { phoneKey } from './fields.js';

// Strip what varies between two spellings of the same place: punctuation,
// spacing, the optional yod/vav (קרית/קריית), and a leading "מסעדת".
export const dupKey = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFC')
  .replace(/^\s*(מסעדת|מסעדה|restaurant)\s+/u, '')
  .replace(/[\s"'`׳״‘’“”\-–—.,:;!?()]/g, '')
  .replace(/[יו]/g, '');

export function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// Chains share one national number (1-700, 1-800, *1234) across every branch --
// 68 Pizza Hut branches on the live map have the same one -- so only ordinary
// numbers identify a place. Extensions are ignored: same switchboard, same place.
const placePhone = (p) => {
  const k = phoneKey(p);
  return k && !/^1[5-9]00/.test(k) && !k.startsWith('*') ? k : '';
};

/**
 * `existing` is [{ source, id, name, city, phone }]. A match is the same city
 * with a near-identical name, or the same ordinary phone number anywhere. Two
 * branches of one chain in the same city also match; that's for the moderator.
 */
export function duplicateFlags(data, existing) {
  const name = dupKey(data.name);
  const city = dupKey(data.city);
  const phone = placePhone(data.phone);
  const flags = [];
  for (const r of existing) {
    const sameCity = city && dupKey(r.city) === city;
    const nameMatch = sameCity && similarity(name, dupKey(r.name)) >= 0.85;
    const phoneMatch = phone !== '' && placePhone(r.phone) === phone;
    if (nameMatch || phoneMatch) {
      flags.push({
        kind: 'duplicate', source: r.source, id: r.id, name: r.name,
        reason: nameMatch ? 'same name and city' : 'same phone',
      });
    }
    if (flags.length >= 5) break;
  }
  return flags;
}
