/* Kosher Restaurant Map -- static frontend.
 *
 * Everything is precomputed by scripts/build.mjs: this file only fetches one
 * JSON document, renders markers, and filters them in memory. No geocoding and
 * no scraping happen in the browser.
 */
(() => {
  'use strict';

  const DATA_URL = 'data/restaurants.json';
  const ISRAEL_CENTER = [31.6, 34.98];

  // Facet key -> the record property it filters on.
  const FACETS = {
    types: 'type',
    areas: 'area',
    cities: 'city',
    hechsherim: 'kashrut',
  };
  // Short names keep the shareable URL readable.
  const HASH_KEYS = { types: 't', areas: 'a', cities: 'c', hechsherim: 'k' };

  const $ = (id) => document.getElementById(id);
  // Interface text only (i18n.js); restaurant information is shown as it is.
  const { t, lang } = window.i18n;

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;   // never innerHTML: data is scraped
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  };

  /** Only http(s) URLs reach an href/src: every field here is scraped content. */
  const safeUrl = (u) => {
    // Empty is not a link -- new URL('', base) would quietly be this very page.
    if (!u) return null;
    try {
      const parsed = new URL(u, location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
    } catch { return null; }
  };

  const state = {
    all: [],
    meta: null,
    selected: { types: new Set(), areas: new Set(), cities: new Set(), hechsherim: new Set() },
    query: '',
    citySearch: '',
    // Grouped pins (clusters that split as you zoom) by default; "show all
    // pins" draws every restaurant as its own pin.
    allPins: false,
  };

  let map, cluster, plain;
  const pinLayer = () => (state.allPins ? plain : cluster);

  // -------------------------------------------------------------------------
  // filtering
  // -------------------------------------------------------------------------

  const matchesQuery = (r, q) =>
    !q ||
    r.name.toLowerCase().includes(q) ||
    r.address.toLowerCase().includes(q) ||
    r.city.toLowerCase().includes(q);

  /** Applies every facet except `skip` (used to compute contextual counts). */
  function filtered(skip) {
    const q = state.query;
    return state.all.filter((r) => {
      for (const [facet, prop] of Object.entries(FACETS)) {
        if (facet === skip) continue;
        const sel = state.selected[facet];
        // OR within a facet, AND across facets.
        if (sel.size && !sel.has(r[prop])) return false;
      }
      return matchesQuery(r, q);
    });
  }

  const countsFor = (facet) => {
    const prop = FACETS[facet];
    const m = new Map();
    for (const r of filtered(facet)) {
      if (r[prop]) m.set(r[prop], (m.get(r[prop]) || 0) + 1);
    }
    return m;
  };

  // -------------------------------------------------------------------------
  // rendering: markers
  // -------------------------------------------------------------------------

  function popupFor(r) {
    const dl = el('dl');
    const row = (label, value) => {
      if (!value) return;
      dl.appendChild(el('dt', { text: label }));
      // dir=auto: Hebrew data reads right to left even on the English page.
      dl.appendChild(el('dd', { text: value, dir: 'auto' }));
    };
    row(t('pop.address'), [r.address, r.city].filter(Boolean).join(', '));
    row(t('pop.kashrut'), r.kashrut);
    row(t('pop.type'), r.type);
    row(t('pop.phone'), r.phone);
    row(t('pop.hours'), r.hours);

    const box = el('div', { class: 'pop' }, [el('h3', { text: r.name, dir: 'auto' })]);
    if (r.source === 'community') {
      box.appendChild(el('p', { class: 'badge', text: t('pop.community') }));
    }
    if (r.description) box.appendChild(el('p', { class: 'desc', text: r.description, dir: 'auto' }));

    const imgSrc = safeUrl(r.image);
    if (imgSrc) {
      const img = el('img', { src: imgSrc, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.remove());
      box.appendChild(img);
    }
    box.appendChild(dl);

    // Anything short of a house-number match gets an explicit caveat.
    if (r.precision === 'street' || r.precision === 'city') {
      box.appendChild(el('p', { class: 'approx', text: t(`pop.approx.${r.precision}`) }));
    }

    const links = el('div', { class: 'links' });
    const q = encodeURIComponent([r.name, r.address, r.city, 'ישראל'].filter(Boolean).join(', '));
    links.appendChild(el('a', {
      href: `https://www.google.com/maps/search/?api=1&query=${q}`,
      target: '_blank', rel: 'noopener noreferrer', text: t('pop.navigate'),
    }));
    const detailUrl = safeUrl(r.link);
    if (detailUrl) {
      links.appendChild(el('a', {
        href: detailUrl, target: '_blank', rel: 'noopener noreferrer', text: t('pop.details'),
      }));
    }
    if (r.phone) {
      links.appendChild(el('a', { href: `tel:${r.phone.replace(/[^\d+]/g, '')}`, text: t('pop.call') }));
    }
    const site = safeUrl(r.website);
    if (site) {
      links.appendChild(el('a', { href: site, target: '_blank', rel: 'noopener noreferrer nofollow', text: t('pop.website') }));
    }
    if (r.whatsapp) {
      // wa.me wants the international form: 054... -> 97254...
      const digits = r.whatsapp.replace(/[^\d]/g, '').replace(/^0/, '972');
      links.appendChild(el('a', {
        href: `https://wa.me/${digits}`, target: '_blank', rel: 'noopener noreferrer', text: t('pop.whatsapp'),
      }));
    }
    box.appendChild(links);

    // Closed, wrong details, misplaced pin: our own update/report page.
    const langParam = new URLSearchParams(location.search).get('lang');
    const updateUrl = `update.html?id=${encodeURIComponent(r.id)}${langParam ? `&lang=${encodeURIComponent(langParam)}` : ''}`;
    box.appendChild(el('a', { class: 'update-link', href: updateUrl, text: t('pop.update') }));
    return box;
  }

  function renderMarkers(rows, { fit = true } = {}) {
    cluster.clearLayers();
    plain.clearLayers();
    const mapped = rows.filter((r) => r.lat !== null && r.lon !== null);
    const markers = mapped.map((r) =>
      L.marker([r.lat, r.lon], { title: r.name }).bindPopup(() => popupFor(r)));
    if (state.allPins) markers.forEach((m) => plain.addLayer(m));
    else cluster.addLayers(markers);

    if (mapped.length && fit) {
      map.fitBounds(L.latLngBounds(mapped.map((r) => [r.lat, r.lon])),
        { padding: [40, 40], maxZoom: 15 });
    }
    return mapped.length;
  }

  // -------------------------------------------------------------------------
  // rendering: facet controls
  // -------------------------------------------------------------------------

  function option(facet, name, count, checked, disabled) {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => {
      state.selected[facet][input.checked ? 'add' : 'delete'](name);
      update();
    });
    return el('label', { class: `opt${disabled ? ' disabled' : ''}` }, [
      input,
      el('span', { class: 'name', text: name, dir: 'auto' }),
      el('span', { class: 'count', text: String(count) }),
    ]);
  }

  function renderFacet(facet) {
    const box = $(`facet-${facet}`);
    const counts = countsFor(facet);
    const sel = state.selected[facet];
    box.replaceChildren();

    if (facet === 'cities') return renderCities(box, counts, sel);

    for (const { name } of state.meta.facets[facet]) {
      const n = counts.get(name) || 0;
      box.appendChild(option(facet, name, n, sel.has(name), n === 0 && !sel.has(name)));
    }
  }

  /** Cities are numerous, so they get a search box and are grouped by region. */
  function renderCities(box, counts, sel) {
    const needle = state.citySearch;
    const areaSel = state.selected.areas;

    const visible = state.meta.facets.cities.filter((c) => {
      if (needle && !c.name.toLowerCase().includes(needle)) return false;
      // Picking a region narrows the city list to that region's cities.
      if (areaSel.size && !areaSel.has(c.area) && !sel.has(c.name)) return false;
      return (counts.get(c.name) || 0) > 0 || sel.has(c.name);
    });

    if (!visible.length) {
      box.appendChild(el('p', { class: 'empty-note', text: t('city.none') }));
      return;
    }

    const byArea = new Map();
    for (const c of visible) {
      if (!byArea.has(c.area)) byArea.set(c.area, []);
      byArea.get(c.area).push(c);
    }

    for (const [area, list] of byArea) {
      box.appendChild(el('div', { class: 'city-group', text: area || t('city.otherArea'), dir: 'auto' }));
      for (const c of list) {
        const n = counts.get(c.name) || 0;
        box.appendChild(option('cities', c.name, n, sel.has(c.name), n === 0 && !sel.has(c.name)));
      }
    }
  }

  function renderUnmapped(rows) {
    const unmapped = rows.filter((r) => r.lat === null);
    const section = $('unmapped');
    const list = $('unmapped-list');

    section.hidden = unmapped.length === 0;
    if (!unmapped.length) return;

    $('unmapped-label').textContent = t('unmapped', { n: unmapped.length });
    list.replaceChildren(...unmapped.map((r) =>
      el('li', {}, [
        el('span', { class: 'n', text: r.name, dir: 'auto' }),
        el('span', { class: 'a', text: [r.address, r.city].filter(Boolean).join(', '), dir: 'auto' }),
      ])));
  }

  // -------------------------------------------------------------------------
  // URL hash
  // -------------------------------------------------------------------------

  function writeHash() {
    const parts = [];
    for (const [facet, key] of Object.entries(HASH_KEYS)) {
      const sel = state.selected[facet];
      if (sel.size) parts.push(`${key}=${[...sel].map(encodeURIComponent).join(',')}`);
    }
    if (state.query) parts.push(`q=${encodeURIComponent(state.query)}`);
    if (state.allPins) parts.push('p=all');
    const hash = parts.join('&');
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

  function readHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    for (const [facet, key] of Object.entries(HASH_KEYS)) {
      const v = params.get(key);
      if (v) state.selected[facet] = new Set(v.split(',').filter(Boolean));
    }
    state.allPins = params.get('p') === 'all';
    const q = params.get('q');
    if (q) {
      state.query = q.toLowerCase();
      $('search').value = q;
    }
  }

  // -------------------------------------------------------------------------
  // update cycle
  // -------------------------------------------------------------------------

  function update({ fit = true } = {}) {
    const rows = filtered(null);

    for (const facet of Object.keys(FACETS)) renderFacet(facet);
    for (const btn of document.querySelectorAll('.clear-facet')) {
      btn.hidden = state.selected[btn.dataset.clear].size === 0;
    }

    const mappedCount = renderMarkers(rows, { fit });
    renderUnmapped(rows);

    const total = state.meta.counts.total;
    $('result-count').textContent =
      rows.length === total
        ? t('count.all', { n: total })
        : t('count.some', { n: rows.length, total });

    const status = $('status');
    if (!rows.length) {
      status.hidden = false;
      status.textContent = t('status.none');
    } else if (mappedCount === 0) {
      status.hidden = false;
      status.textContent = t('status.noneMapped');
    } else {
      status.hidden = true;
    }

    writeHash();
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  function wireUp() {
    window.i18n.followTypedDirection($('search'));
    window.i18n.followTypedDirection($('city-search'));
    let t;
    $('search').addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value.trim().toLowerCase();
      t = setTimeout(() => { state.query = v; update(); }, 180);
    });

    let ct;
    $('city-search').addEventListener('input', (e) => {
      clearTimeout(ct);
      const v = e.target.value.trim().toLowerCase();
      ct = setTimeout(() => {
        state.citySearch = v;
        renderFacet('cities');
      }, 140);
    });

    for (const btn of document.querySelectorAll('.clear-facet')) {
      btn.addEventListener('click', () => {
        state.selected[btn.dataset.clear].clear();
        update();
      });
    }

    $('reset-all').addEventListener('click', () => {
      for (const s of Object.values(state.selected)) s.clear();
      state.query = '';
      state.citySearch = '';
      $('search').value = '';
      $('city-search').value = '';
      update();
    });

    const toggle = $('filters-toggle');
    toggle.addEventListener('click', () => {
      const open = $('sidebar').classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });

    const ut = $('unmapped-toggle');
    ut.addEventListener('click', () => {
      const list = $('unmapped-list');
      list.hidden = !list.hidden;
      ut.setAttribute('aria-expanded', String(!list.hidden));
    });
  }

  async function init() {
    map = L.map('map', { center: ISRAEL_CENTER, zoom: 8, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    cluster = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
    });
    plain = L.featureGroup();

    // "Show all pins": a checkbox on the map, under the zoom buttons.
    const PinsControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('label', 'pins-toggle leaflet-bar');
        const input = L.DomUtil.create('input', '', box);
        input.type = 'checkbox';
        input.id = 'all-pins';
        L.DomUtil.create('span', '', box).textContent = t('pins.all');
        L.DomEvent.disableClickPropagation(box);
        input.addEventListener('change', () => {
          state.allPins = input.checked;
          map.removeLayer(state.allPins ? cluster : plain);
          map.addLayer(pinLayer());
          update({ fit: false }); // same view, different pins
        });
        return box;
      },
    });
    map.addControl(new PinsControl());

    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.meta = await res.json();
      state.all = state.meta.restaurants;
    } catch (err) {
      $('status').textContent = t('status.error');
      console.error(err);
      return;
    }

    const when = new Date(state.meta.generated);
    $('meta').replaceChildren(
      document.createTextNode(
        `${t('meta.updated', { date: when.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US') })} · `),
      el('a', {
        href: safeUrl(state.meta.source) || '#', target: '_blank', rel: 'noopener noreferrer',
        text: t('meta.source'),
      }),
      document.createTextNode(` · ${t('meta.counts', {
        mapped: state.meta.counts.mapped, unmapped: state.meta.counts.unmapped })}`),
    );

    readHash();
    $('all-pins').checked = state.allPins;
    map.addLayer(pinLayer());
    wireUp();
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
