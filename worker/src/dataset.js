/**
 * The live map's data (rest.jdn.co.il records, as the site's build publishes
 * them), used to check duplicates and to validate edits. Cached per isolate.
 */

const TTL_MS = 10 * 60 * 1000;
let cache = null; // { at, byId }

export function resetDatasetCache() {
  cache = null;
}

/** Map of jdn id (string) -> record. Throws if the dataset can't be read. */
export async function jdnRecords(env) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byId;
  if (!env.DATASET_URL) throw new Error('DATASET_URL is not set');
  const res = await fetch(env.DATASET_URL, {
    signal: AbortSignal.timeout(5000),
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`dataset ${res.status}`);
  const data = await res.json();
  // The map also carries our community listings (the build merges them in);
  // they are ours, not jdn's, and are read from the database instead.
  const byId = new Map((data.restaurants || [])
    .filter((r) => r.source !== 'community')
    .map((r) => [String(r.id), r]));
  cache = { at: Date.now(), byId };
  return byId;
}

/**
 * A jdn record in the shape of our form fields (their `kashrut` is our
 * `hechsher`) -- jdn's own values. The map shows our corrections in the
 * fields themselves and keeps jdn's in `upstream`; comparing corrections with
 * the shown values would make every one look overtaken.
 */
export const asFields = (r) => {
  const up = r.upstream || {};
  const v = (prop) => up[prop] ?? r[prop];
  return {
    name: v('name'), address: v('address'), city: v('city'), type: v('type'),
    hechsher: v('kashrut'), phone: v('phone'),
  };
};
