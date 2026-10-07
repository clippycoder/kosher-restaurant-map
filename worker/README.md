# Community submissions API

Live at **https://kosher-map-submissions.clippycoder.workers.dev** (not yet used by
the site; the captcha secret is still to be set, so public posts refuse with 503).

Our own form and database for adding restaurants, editing jdn's, and reporting problems, kept
apart from rest.jdn.co.il: nothing is written back upstream, and upstream data
never lands here. GitHub Pages can only serve files, so this small Cloudflare
Worker with a D1 database receives submissions. It does no geocoding; the site's
daily build pulls published entries and locates them like any other record.

## Flow

```
form ──POST /api/submissions──▶ validate ─▶ captcha ─▶ rate limit ─▶ screen
                                                                     │
                                  clean ─▶ published ─▶ GET /api/published ─▶ daily build ─▶ map
                                                      GET /api/versions ──┘  (accepted edits of jdn listings)
                                flagged ─▶ held ─▶ moderator: publish / reject / edit
```

- **Refused outright** when a field is invalid, including a malformed phone number.
  The form loads the same rules (`public/forms/fields.js`) and blocks the submit
  button, so people see the problem before sending. Phones accept every Israeli
  spelling, 1-700/1-800, star numbers typed either side (`*2242`, `2242*`),
  extensions (`שלוחה 6`) and `+`-prefixed foreign numbers; against the live map
  they reject only jdn's 4 typos (a digit too many or too few).
- **Published automatically** unless screening flags it. Screening looks only at
  the required text fields (name, address, city) and holds:
  - links, emails, a character repeated 5+ times, Latin consonant runs (`qwrtzx`),
    text with no letters;
  - listed spam and offensive words, Hebrew and English, as whole words only.
    Hebrew prefixes aren't stripped (מזונות minus its מ is a slur), and words
    with ordinary meanings (כוס, תחת, זין, ליווי alone) aren't listed;
  - scripts other than Hebrew, Latin, Chinese, Japanese, Korean and Cyrillic;
  - an address that is just the name, just the city, or the two together.

  Run over the 624 live restaurants that have a city, it flags none of them.
- **Likely duplicates are held too**: same city with a near-identical name (spelling
  variants such as קרית/קריית folded), or the same ordinary phone number, against
  both the live map and earlier submissions. Chains' national numbers (1-700,
  1-800, \*1234) are ignored, since one of them covers 68 branches.
- **Reports** ("closed", "wrong details", "wrong location", "kashrut changed") are
  stored for the moderator and never change anything by themselves.

## Editing jdn restaurants

An edit (`POST /api/edits`) names a jdn restaurant and carries only the fields it
changes. Each field is decided on its own:

- **Two different people, same value → accepted immediately.** Different means
  a different fingerprint *and* at least an hour apart, so flipping from Wi-Fi to
  mobile data doesn't let someone confirm their own edit. "Same" ignores
  case, spacing and punctuation (including the maqaf), and phones compare as
  numbers. Same person twice doesn't count. If one edit changes phone and hours
  and another only the phone, the phone is accepted and the hours keep waiting.
- **Otherwise it waits** for a matching second edit or the moderator. "Different
  people" is judged by the submitter fingerprint, which lasts 30 days, so a
  second edit has to arrive within 30 days to confirm the first automatically.
- **Flagged edits** (spam in name/address/city) neither confirm nor get confirmed.

Accepted values form **our version** of the restaurant, one row per field in
`versions`, published at `GET /api/versions`. Each row stores the jdn value it
replaced. **When jdn changes a field, theirs wins for that field only**: our
value for it is dropped, and our values for the restaurant's other fields stay.
Pending edits made against jdn's old value go `stale` and can't be confirmed by
edits made against the new one. The worker retires overtaken rows whenever the
restaurant is next edited; the build applies a value only while jdn's current
value still matches `base`, so the map is right either way.

## Fields

Defined once in [`public/forms/fields.js`](../public/forms/fields.js), which the
page imports and the worker bundles, so both run the same validation. Deploy
both (push for Pages, `npm run deploy` here) when it changes.
Adding or removing a field needs no migration; submissions are stored as JSON.

| Section | Field | |
| --- | --- | --- |
| main (required) | name, address, city, type, hechsher (jdn's 13) | |
| main (optional) | phone | public |
| advanced (optional) | short description, WhatsApp, website/Instagram, hours, delivery, accessible, reservation required | public |
| advanced (optional) | relation to the place, owner phone, mashgiach phone | **private** |

Private fields go into a separate column and are returned only on admin routes.
Region is not asked; the build derives it from the city.

## Abuse and privacy

- Cloudflare Turnstile captcha, plus a hidden honeypot field.
- 5 submissions and 10 reports per person per day; 300 / 500 per day overall.
- The "person" is a SHA-256 of a secret salt and the IP. The raw IP is never
  stored. It is stable, so it does link one person's posts, which is what lets
  edits be told apart as coming from different people; a nightly cron clears it
  after 30 days.
- CORS allows only the site's origin. Bodies over 32 KB are refused. Unknown
  fields are dropped rather than stored.
- With a secret missing, the routes that need it refuse instead of running open.

## Moderation

```sh
export SUBMISSIONS_API=https://kosher-map-submissions.clippycoder.workers.dev
export ADMIN_TOKEN=$(security find-generic-password -a kosher-map -s kosher-map-admin-token -w)
node scripts/moderate.mjs list                 # held entries, with why
node scripts/moderate.mjs show 12
node scripts/moderate.mjs publish 12
node scripts/moderate.mjs edit 12 name="Burger Bar" --publish
node scripts/moderate.mjs reject 12 "spam"
node scripts/moderate.mjs delete 12            # for removal requests
node scripts/moderate.mjs edits                # pending edits of jdn restaurants
node scripts/moderate.mjs accept 7 phone hours  # accept named fields (or all)
node scripts/moderate.mjs decline 7
node scripts/moderate.mjs versions             # our values over jdn's
node scripts/moderate.mjs unversion 2699 phone # drop one; jdn's shows again
node scripts/moderate.mjs reports              # open reports
node scripts/moderate.mjs resolve 3 "hid it"
```

## Running locally

```sh
cp .dev.vars.example .dev.vars    # Turnstile test keys; accepts any token
npm run migrate:local
npm run dev                       # http://localhost:8787
npm test                          # node:test over an in-memory SQLite D1 stand-in
```

## Deployment

Deployed 2026-10-07 to the project owner's Cloudflare account. D1
database `kosher-map-submissions` (id in `wrangler.toml`) has the migration
applied. `ADMIN_TOKEN` and `RATE_SALT` are set; the admin token is also in the
macOS Keychain (service `kosher-map-admin-token`, account `kosher-map`).

**Still to do:** create a Turnstile widget in the Cloudflare dashboard
(Turnstile → Add widget, hostname `clippycoder.github.io`, mode Managed). Its
site key goes in the page; its secret goes here:

```sh
wrangler secret put TURNSTILE_SECRET
```

Redeploying after a change:

```sh
npm test && npm run deploy
npm run migrate:remote            # only when migrations/ gained a file
```

Everything used sits inside the free tier: 100k Worker requests/day, 5 GB of D1,
Turnstile free.
