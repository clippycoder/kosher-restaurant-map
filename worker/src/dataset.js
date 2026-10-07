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
  const byId = new Map((data.restaurants || []).map((r) => [String(r.id), r]));
  cache = { at: Date.now(), byId };
  return byId;
}

/** A jdn record in the shape of our form fields (their `kashrut` is our `hechsher`). */
export const asFields = (r) => ({
  name: r.name, address: r.address, city: r.city, type: r.type, hechsher: r.kashrut, phone: r.phone,
});
