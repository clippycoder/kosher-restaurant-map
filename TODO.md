# TODO

- **"Show all pins" is slow.** It draws all ~626 restaurants as separate Leaflet
  markers, each its own DOM element, and slows the browser down. Likely fix:
  draw them on a canvas (`preferCanvas` / `L.circleMarker`), or only add the
  pins inside the current view and refresh on pan/zoom.
- **53 pins sit at a city centre** because no address was found (e.g. landmarks
  like `קריית המדע הר חוצבים`). Fix by hand in `data/overrides.json`, or with a
  better geocoder (GovMap needs a registered API key).
- **Replay of a used captcha token** is refused by Cloudflare by design, but has
  not been tested end to end with a real token (only a person can get one).
- **English title on narrow phones** shows as "Kosher R…" at 360px; a shorter
  English title would fit.
- **"Back to map" arrow** keeps its Hebrew direction (›) in English, as part of
  keeping the Hebrew layout.
