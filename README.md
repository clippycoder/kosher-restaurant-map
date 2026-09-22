# Kosher Restaurant Map

A map of supervised (בהשגחה) kosher restaurants in Israel, filterable by city,
region, type (בשרי / חלבי / פרווה) and hechsher.

Data comes from [rest.jdn.co.il](https://rest.jdn.co.il). The site is a static page:
all scraping and geocoding happen ahead of time in a scheduled GitHub Action, so a
visitor's browser only downloads one JSON file.

## How it works

```
GitHub Action (daily cron)
   │
   ├─ 1. Read taxonomy terms + restaurant index from the WP REST API   (~7 requests)
   ├─ 2. Fetch detail pages for new/modified records only     (0–5 in steady state)
   ├─ 3. Locate addresses missing from the cache              (0–5 in steady state)
   ├─ 4. Write public/data/restaurants.json + data/geocache.json
   └─ 5. Commit if changed  →  Pages redeploys

Browser → public/index.html → fetch('data/restaurants.json') → Leaflet + clustering
```

## Geocoding

Nominatim alone is not good enough here. Its free-text search fails on ordinary
Hebrew addresses that OSM plainly contains — `יפו 217`, `שמגר 16`, `אגריפס 109` all
returned nothing, which left two thirds of pins sitting at city centres.

So addresses resolve through a local gazetteer first, and each pin records how
precisely it was placed:

| `precision` | Meaning |
| --- | --- |
| `address` | Matched a house number. |
| `street` | Street found, house number not. Popup says so. |
| `city` | City centre only. Popup says so. |
| `null` | Unresolved; listed in the map's "no exact location" panel. |

The order is by precision, not by source — a house-number match from either
source beats a street-level match from the other:

1. **OSM gazetteer** (`scripts/gazetteer.mjs`) — one Overpass query per city pulls
   every `addr:housenumber`+`addr:street` point plus named roads (22,438 points and
   1,463 numbered streets for Jerusalem alone), then matches locally.
2. **Nominatim**, tightest query first, loosening through a cascade.
3. **City centre**, as a flagged last resort.

Three things make the matching work, and all three were necessary:

- **Multiple candidate readings per address.** The city is often appended with no
  comma (`שד' בן צבי 11 ירושלים`) and a mall name frequently precedes the real
  street (`קניון סנטר 1, ירמיהו 43`), so the first number in the string is
  regularly the wrong one. The parser emits several readings and lets the
  gazetteer pick the one it recognises.
- **Fuzzy street matching**, because the two datasets disagree on spellings
  (`לואיס בריינדס` vs `לואיס ברנדייס`).
- **A 25 km distance guard** from the city centre on every result. Without it
  Nominatim places a Jerusalem restaurant on a street named *ירושלים* in Sderot —
  the same class of error that made the original version unusable.

Gazetteer lookups are memoised into `data/geocache.json` under `gaz:` keys, so a
CI run that starts with an empty `.cache/` makes no Overpass calls at all once the
cache is committed. Building all ~107 city gazetteers from cold takes about three
hours; after that it is seconds.

`api.govmap.gov.il` is the authoritative Israeli geocoder and would likely beat
this, but it requires an API key bound to an approved domain, which does not suit
a static site built by a script. It is the natural upgrade if you register one.

Two things make repeat runs cheap. Each record's `modified_gmt` from the API is
compared against the last build, so unchanged restaurants are never re-fetched. And
every geocode result is cached in `data/geocache.json` and committed, so an address
is looked up once and the answer is shared by every visitor — rather than every
browser repeating the work into its own `localStorage`.

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/build.mjs` | The whole pipeline. Node 20+, no dependencies. |
| `scripts/gazetteer.mjs` | OSM/Overpass address gazetteer and the street matcher. |
| `scripts/verify.mjs` | Checks the built dataset against the live API. |
| `scripts/serve.mjs` | Static server for local preview. |
| `.cache/gazetteer/` | Downloaded OSM address data. Gitignored, safe to delete. |
| `public/` | The deployed site. This directory is the Pages root. |
| `public/data/restaurants.json` | **Generated.** The only file the browser fetches. |
| `data/geocache.json` | **Generated.** Permanent geocode memo, including misses. |
| `data/overrides.json` | **Hand-edited.** Forced coordinates for addresses Nominatim gets wrong. |
| `data/city-aliases.json` | **Hand-edited.** City spelling variant → canonical name. |

`data/` holds build state and is not published; `public/data/` holds the one document
the site serves.

## Running it

```sh
node scripts/build.mjs --sample   # 5 known records, ~15s -- use this to check extraction
node scripts/build.mjs            # full build
node scripts/serve.mjs            # preview at http://localhost:8080
```

The first full build takes roughly 25 minutes: 641 detail pages at 1 request/second
plus the same number of geocodes at 1.1 s. Subsequent builds finish in seconds.

Both delays are deliberate. Nominatim's usage policy caps you at one request per
second and requires an identifying `User-Agent`; both are set in `build.mjs`. Do not
parallelise either loop.

## Maintenance

**A city shows up twice under slightly different spellings.** The `עיר` field upstream
is free text, not a controlled vocabulary, so variants appear over time. Every build
prints cities with fewer than three records — that list is where variants surface. Add
the variant to `data/city-aliases.json`:

```json
{ "תל-אביב יפו": "תל אביב" }
```

**A pin is in the wrong place, or a restaurant is missing from the map.** Add the exact
geocode query string to `data/overrides.json`. The query is built as
`"<street>, <city>, ישראל"`:

```json
{
  "המרפא 1, ירושלים, ישראל": { "lat": 31.8005, "lon": 35.2123, "note": "Nominatim hit the wrong block" }
}
```

Overrides win over both the cache and Nominatim. Neither hand-edited file is ever
overwritten by the build.

**Restaurants with no usable address** fall back to the city centre and are marked
`precision: "city"`; their popups say the location is approximate. Anything that fails
entirely keeps `lat: null` and is listed in the map's "ללא מיקום מדויק" panel rather
than being silently dropped.

**The build aborts** if more than 20% of records come back with no address. That means
the upstream page template changed and the label-based extraction in `parseDetail()`
needs updating — better to fail than to commit a gutted dataset over a good one.

## Deploying

Push to `main` with GitHub Pages set to "GitHub Actions" as the source. `pages.yml`
publishes `public/`; `build.yml` refreshes the data on a daily cron and can be run
on demand from the Actions tab.

Keep the repository public if you want the daily cron to be free — public repos get
unlimited Actions minutes. On a private repo, switch the cron to weekly to stay well
inside the 2,000 minute/month allowance.

## Notes

- Restaurant names, addresses and photos are third-party content, so popups are built
  with `textContent` and `createElement` rather than string interpolation.
- Tiles are OpenStreetMap. The upstream site embeds its own Google Maps API keys in its
  page source; those belong to the site owner and are not used here.
