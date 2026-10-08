# TODO

- **"Show all pins" performance.** Now offered only from zoom 12 and drawing
  only pins near the view (central Jerusalem at zoom 12: 176 in view, ~220
  drawn, down from all 626). If dense areas are still slow, draw on a canvas
  (`preferCanvas` / `L.circleMarker`).
  like `קריית המדע הר חוצבים`). Fix by hand in `data/overrides.json`, or with a
  better geocoder (GovMap needs a registered API key).
- **Replay of a used captcha token** is refused by Cloudflare by design, but has
  not been tested end to end with a real token (only a person can get one).
- **English title on narrow phones** shows as "Kosher R…" at 360px; a shorter
  English title would fit.
- **"Back to map" arrow** keeps its Hebrew direction (›) in English, as part of
  keeping the Hebrew layout.
