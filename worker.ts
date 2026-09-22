export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ========================================================================
    // 1. API ENDPOINT
    // ========================================================================
    if (url.pathname === "/api/restaurants") {

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;

      const params = new URLSearchParams();
      params.append('action', 'jet_engine_ajax');
      params.append('handler', 'listing_load_more');
      params.append('query[post_status][]', 'publish');
      params.append('query[post_type]', 'rest');
      params.append('query[posts_per_page]', '2000');
      params.append('query[paged]', '1');
      params.append('widget_settings[lisitng_id]', '31');
      params.append('page_settings[queried_id]', '6|WP_Post');

      try {
        const fetchResponse = await fetch("https://rest.jdn.co.il/", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MapBot/1.0"
          },
          body: params.toString()
        });

        const json = await fetchResponse.json();
        const htmlString = json.data && json.data.html ? json.data.html : "";

        let current = { name: "", address: "", kashrut: "" };
        let addrLocked = false;
        let inAddrSpan  = false;
        const restaurants = [];

        const rewriter = new HTMLRewriter()
          .on('div.jet-listing-grid__item', {
            element() {
              if (current.name.trim() !== "") {
                restaurants.push({
                  name:    current.name.trim(),
                  address: current.address.trim(),
                  kashrut: current.kashrut.trim()
                });
              }
              current     = { name: "", address: "", kashrut: "" };
              addrLocked  = false;
              inAddrSpan  = false;
            }
          })
          .on('h2.elementor-heading-title a', {
            text(t) { current.name += t.text; }
          })
          .on('span.elementor-icon-list-text', {
            element(el) {
              // FIX 1: Only capture the FIRST span per card (the address).
              // Later spans (phone, hours, etc.) share the same class and were
              // previously concatenated into the address string, producing garbage
              // queries that Nominatim couldn't geocode.
              if (!addrLocked) {
                inAddrSpan = true;
                el.onEndTag(() => {
                  inAddrSpan = false;
                  addrLocked = true;
                });
              }
            },
            text(t) {
              if (inAddrSpan) current.address += t.text;
            }
          })
          .on('a.jet-listing-dynamic-terms__link', {
            text(t) { current.kashrut += t.text; }
          });

        await rewriter.transform(new Response(htmlString)).text();

        if (current.name.trim() !== "") {
          restaurants.push({
            name:    current.name.trim(),
            address: current.address.trim(),
            kashrut: current.kashrut.trim()
          });
        }

        // FIX 2: Require ירושלים to appear as the CITY (after a comma), not as a
        // street name. Many Israeli cities have a "Jerusalem St/Blvd", so a plain
        // includes() check pulls in restaurants from Ashkelon, Holon, Bnei Brak,
        // Tzfat, etc. that happen to be on "שדרות ירושלים".
        const jerusalemOnly = restaurants.filter(r =>
          /,\s*ירושלים/.test(r.address) ||  // ", ירושלים" → city component
          r.address.trim() === "ירושלים"   || // bare city only
          r.address.includes("Jerusalem")  ||
          r.name.includes("ירושלים")          // branch name explicitly says Jerusalem
        );

        const finalResponse = new Response(JSON.stringify(jerusalemOnly), {
          headers: {
            "Content-Type":                "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control":               "public, max-age=86400"
          }
        });

        ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
        return finalResponse;

      } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to fetch data" }), { status: 500 });
      }
    }

    // ========================================================================
    // 2. FRONTEND
    // ========================================================================
    const html = `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>מפת מסעדות בהשגחה - ירושלים</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
    <style>
        body, html { height: 100%; margin: 0; padding: 0; font-family: Arial, sans-serif; }
        #map { height: 100%; width: 100%; }
        .info-window { text-align: right; }
        .info-window h3 { margin: 0 0 8px 0; color: #d32f2f; }
        .info-window p { margin: 0 0 5px 0; font-size: 14px; }

        #loader {
            position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
            background: white; padding: 10px 20px; border-radius: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2); z-index: 1000; font-weight: bold; color: #333;
        }
        #unmapped {
            position: absolute; bottom: 20px; right: 20px; background: rgba(255,255,255,0.95);
            padding: 15px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            max-height: 250px; overflow-y: auto; z-index: 1000; display: none; width: 250px;
        }
        #unmapped h4 { margin: 0 0 10px 0; color: #d32f2f; font-size: 14px; }
        #unmapped ul { margin: 0; padding-right: 20px; list-style-type: square; }
        #unmapped li { font-size: 12px; margin-bottom: 5px; }
    </style>
</head>
<body>
    <div id="loader">מאתר מסעדות בירושלים...</div>
    <div id="unmapped">
        <h4>לא נמצא מיקום מדויק במפה:</h4>
        <ul id="unmapped-list"></ul>
    </div>
    <div id="map"></div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
    <script>
        async function initMap() {
            const map = L.map('map').setView([31.7816, 35.2185], 13);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap'
            }).addTo(map);

            const loader      = document.getElementById("loader");
            const unmappedBox = document.getElementById("unmapped");
            const unmappedList= document.getElementById("unmapped-list");

            try {
                const response = await fetch("/api/restaurants?v=5");
                const restaurants = await response.json();

                if (!restaurants || restaurants.length === 0) {
                    loader.innerText = 'לא נמצאו מסעדות בירושלים';
                    return;
                }

                const placeMarker = (lat, lon, r) => {
                    L.marker([lat, lon]).addTo(map).bindPopup(\`
                        <div class="info-window">
                            <h3>\${r.name}</h3>
                            <p><strong>כתובת:</strong> \${r.address}</p>
                            <p><strong>כשרות:</strong> \${r.kashrut || 'לא צוין'}</p>
                        </div>
                    \`);
                };

                const addUnmapped = (r) => {
                    unmappedBox.style.display = "block";
                    const li = document.createElement("li");
                    li.innerHTML = \`<strong>\${r.name}</strong><br>\${r.address}\`;
                    unmappedList.appendChild(li);
                };

                // FIX 3: Build the Nominatim search string by stripping only the
                // TRAILING city/country suffix. The old approach (global replace of
                // all ירושלים occurrences) destroyed embedded place names such as
                // "תחנה מרכזית ירושלים" or "קניון רמות ירושלים", producing mangled
                // query strings that Nominatim rejected.
                const buildSearchAddress = (address) => {
                    let clean = address
                        .replace(/،/g, ",")              // normalize Arabic comma
                        .replace(/,\s*ישראל\s*$/, "")    // drop trailing ", ישראל"
                        .replace(/,\s*ירושלים\s*$/, "")  // drop trailing ", ירושלים"
                        .trim()
                        .replace(/,\s*$/, "")            // drop any leftover trailing comma
                        .trim();
                    return (clean === "" || clean === "ירושלים")
                        ? "ירושלים, ישראל"
                        : clean + ", ירושלים, ישראל";
                };

                const cachedItems   = [];
                const uncachedItems = [];

                // geo_v2_ prefix: invalidates entries cached under the old broken
                // search strings so everything is re-geocoded with clean addresses.
                const CACHE_PREFIX = "geo_v2_";

                restaurants.forEach((r) => {
                    const searchAddress = buildSearchAddress(r.address);
                    const hit = localStorage.getItem(CACHE_PREFIX + searchAddress);
                    if (hit) {
                        cachedItems.push({ r, searchAddress, coords: JSON.parse(hit) });
                    } else {
                        uncachedItems.push({ r, searchAddress });
                    }
                });

                // Instant load: render everything already in cache
                cachedItems.forEach(item => {
                    if (item.coords.lat && item.coords.lon) {
                        placeMarker(item.coords.lat, item.coords.lon, item.r);
                    } else {
                        addUnmapped(item.r);
                    }
                });

                let processed = cachedItems.length;

                const updateLoader = () => {
                    processed++;
                    const remaining = restaurants.length - processed;
                    loader.innerText = 'נטענו ' + cachedItems.length + ' ממטמון. מציב ' + remaining + ' חדשות...';
                    if (processed >= restaurants.length) {
                        loader.style.display = 'none';
                    }
                };

                if (uncachedItems.length === 0) {
                    loader.style.display = 'none';
                } else {
                    loader.innerText = 'נטענו ' + cachedItems.length + ' ממטמון. מציב ' + uncachedItems.length + ' חדשות...';

                    uncachedItems.forEach((item, index) => {
                        setTimeout(async () => {
                            const query = \`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&q=\${encodeURIComponent(item.searchAddress)}\`;
                            try {
                                const res  = await fetch(query);
                                const data = await res.json();

                                if (data && data.length > 0) {
                                    const lat = data[0].lat;
                                    const lon = data[0].lon;
                                    localStorage.setItem(CACHE_PREFIX + item.searchAddress, JSON.stringify({ lat, lon }));
                                    placeMarker(lat, lon, item.r);
                                } else {
                                    localStorage.setItem(CACHE_PREFIX + item.searchAddress, JSON.stringify({ lat: null, lon: null }));
                                    addUnmapped(item.r);
                                }
                            } catch (e) {
                                localStorage.setItem(CACHE_PREFIX + item.searchAddress, JSON.stringify({ lat: null, lon: null }));
                                addUnmapped(item.r);
                            }

                            updateLoader();

                        }, index * 1200);
                    });
                }

            } catch (error) {
                loader.innerText = 'שגיאה בתקשורת עם השרת';
            }
        }

        window.onload = initMap;
    </script>
</body>
</html>
    `;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};