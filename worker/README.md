# Community submissions API

Live at **https://kosher-map-submissions.clippycoder.workers.dev**; the site's
forms and the daily build use it.

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

## Correcting listings

Community listings and jdn listings are corrected the same way. An edit
(`POST /api/edits`) names a listing -- a jdn post id or one of ours, `c<id>` --
and carries only the fields it changes. Each field is decided on its own:

- **Two different people, same value → accepted immediately.** Different means
  a different fingerprint *and* at least an hour apart, so flipping from Wi-Fi to
  mobile data doesn't let someone confirm their own edit. "Same" ignores case,
  spacing and punctuation (including the maqaf); phones compare as numbers.
  Changing one field and another field on the same edit are decided separately.
- **Otherwise it waits** for a matching second edit (within the fingerprint's 30
  days) or the moderator. Flagged edits neither confirm nor get confirmed.
- **An edit made against a value that has since changed goes `stale`** and can't
  confirm edits made against the new value.

**Where an accepted value goes.** For a community listing, into its own data.
For a jdn listing, into its **shadow**: our own listing in `submissions`
(`shadows` = the jdn id), created by the first accepted correction. It holds a
full copy of the jdn listing with our corrections applied, and for each corrected
field the jdn value it replaced. Shadows follow jdn:

- fields nobody corrected always show jdn's value;
- when jdn changes a corrected field, jdn's value wins and that correction is
  dropped (the shadow goes when none are left);
- when jdn removes the listing, the shadow is **held** for the moderator;
  publishing it keeps it as a listing of our own (it stops shadowing). If jdn's
  listing comes back first, the shadow is released.

The nightly cron runs this sync (`moderate.mjs sync` runs it now); it does
nothing if jdn's data can't be read or looks truncated. The build reads shadows
through `GET /api/versions` (per field, with `base`) and community listings
through `GET /api/published`, which excludes shadows.

## "Is this correct?"

`POST /api/confirmations {restaurant: "c<id>"}` counts one person (fingerprint)
once per published community listing; `GET /api/confirmations/c<id>` returns
`{count, needed, verified, mine}`. At 5 different people the listing gets
`verified_at` and the map stops asking. No captcha -- it is one click -- but 30
confirmations a day per person and 3,000 overall. Someone with many internet
connections could fake it; the stakes are a button disappearing. An accepted
correction clears the listing's confirmations. `/api/published` carries
`confirmations` and `verified`.

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
# No setup: it talks to the live worker and reads the admin token from the
# macOS Keychain. (SUBMISSIONS_API / ADMIN_TOKEN override them, e.g.
# SUBMISSIONS_API=http://localhost:8787 against `npm run dev`.)
node scripts/moderate.mjs list                 # waiting for your review, with why
node scripts/moderate.mjs list mine            # all your listings, newest first, with status
node scripts/moderate.mjs show 12
node scripts/moderate.mjs publish 12
node scripts/moderate.mjs edit 12 name="Burger Bar" --publish
node scripts/moderate.mjs reject 12 "spam"
node scripts/moderate.mjs delete 12            # for removal requests
node scripts/moderate.mjs edits                # pending edits of jdn restaurants
node scripts/moderate.mjs accept 7 phone hours  # accept named fields (or all)
node scripts/moderate.mjs decline 7
node scripts/moderate.mjs versions             # corrections held in shadows of jdn listings
node scripts/moderate.mjs unversion 2699 phone # drop one; jdn's shows again
node scripts/moderate.mjs sync                 # bring shadows into step with jdn now
node scripts/moderate.mjs rebuild --wait       # put what you published on the map now
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
