/* Greece Flood Atlas — MapLibre GL JS front end. Reads files described in DATA_CONTRACT.md. */
(async () => {
  'use strict';
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;

  const TYPE_LABEL = { flash: 'Flash flood', river: 'River flood', coastal: 'Coastal flood', compound: 'River & coastal flood', pluvial: 'Urban flood' };
  const typeLabel = (t) => TYPE_LABEL[t] || 'Other flood';
  // EMS product names -> what they mean to a reader
  const PRODUCT_LABEL = { delineation: 'First map after the flood', monitoring: 'Follow-up map', grading: 'Damage assessment map' };
  const RAMP = ['#e3edf9', '#b3cdeb', '#7aa6d8', '#3f78c0', '#16457f'];
  // One colour per kind of thing on the map (kept deliberately few):
  const FLOOD_COLOR = '#e8590c';                       // major floods (size / height = deaths)
  const LOCAL_COLOR = dark ? '#b197fc' : '#6741d9';    // village flood reports (dots, zoomed in) — not map-label grey
  const EMS_COLOR = '#0c8599';                         // land under water seen by satellite (first map)
  const EMS_LATER_COLOR = '#66d9e8';                   // follow-up map: land still under water weeks later
  // Official overlay maps (ids from data/wms_layers.json) with names a non-specialist understands.
  // Layers not listed here are not shown.
  const OVERLAYS = [
    { group: 'Where floods are expected (Greek Ministry of Environment)', items: [
      { id: 'gr_fd_flood_extent_t50', title: 'Floods expected about once every 50 years' },
      { id: 'gr_fd_flood_extent_t100', title: 'Floods expected about once every 100 years' },
      { id: 'gr_fd_flood_extent_t1000', title: 'Rare extreme floods (about once in 1,000 years)' },
      { id: 'gr_fd_flood_depth_t100', title: 'How deep the water would get (100-year flood)' },
      { id: 'gr_fd_flood_risk_t100', title: 'What is at risk: homes, roads, farms (zoom in)', minzoom: 10 },
      { id: 'gr_fd_apsfr_2019', title: 'Officially designated high flood-risk zones', opacity: 0.5 },
      { id: 'gr_fd_apsfr_rivers', title: 'Rivers in high flood-risk zones' },
      { id: 'gr_river_basin_districts', title: 'River basin boundaries' },
    ] },
    { group: 'European flood models (Copernicus)', items: [
      { id: 'efas_flood_hazard_scenarios', title: 'River flood zones, European model' },
      { id: 'glofas_flood_hazard_100y', title: '100-year river flood zones, global model' },
      { id: 'glofas_major_rivers', title: 'Major rivers' },
    ] },
  ];
  const nf = new Intl.NumberFormat('en');
  const nfc = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const typeColor = () => FLOOD_COLOR; // flood type is a filter, not a colour
  // search matches regardless of accents, case, final sigma or doubled letters ("Larisa" = "Larissa", "λαρισα" = "Λάρισα")
  // Greek is transliterated to Latin on both sides, so "Βόλος", "volos" and "Volos" all match each other.
  const GR = { α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o' };
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ου/g, 'ou').replace(/αυ/g, 'av').replace(/ευ/g, 'ev').replace(/ηυ/g, 'iv')
    .replace(/μπ/g, 'b').replace(/ντ/g, 'd').replace(/γκ|γγ/g, 'g')
    .replace(/[α-ως]/g, (c) => GR[c] || c)
    // Latin spellings vary: Nafplio/Navplio, Kalambaka/Kalabaka, Chania/Hania, Ymittos/Imittos
    .replace(/mp|mb/g, 'b').replace(/nt|nd/g, 'd').replace(/([aei])f/g, '$1v').replace(/ch/g, 'h').replace(/y/g, 'i')
    .replace(/(\p{L})\1+/gu, '$1');

  const state = {
    events: [], byId: new Map(), regions: null, regionBounds: new Map(),
    ems: [], emsLoaded: new Map(), wms: [], local: [],
    filtered: [], years: [0, 0], types: new Set(),
    f: { q: '', ymin: null, ymax: null, fatal: 0, types: new Set() },
    choro: 'count', sort: 'date', is3d: false, selectedRegions: [],
  };

  // ---------- map ----------
  // Basemap: OpenStreetMap vector tiles (OpenFreeMap). Vector labels are rewritten below so the app controls every
  // place name — e.g. "North Macedonia" (OSM name:en) / "Βόρεια Μακεδονία" (name:el) — instead of baked-in raster
  // labels that showed outdated names. Labels follow the page language: Greek browsers get Greek names.
  const LABEL_LANG_KEY = 'gfa-label-lang';
  let labelLang = (() => {
    try { const v = localStorage.getItem(LABEL_LANG_KEY); if (v === 'el' || v === 'en') return v; } catch {}
    return /^el\b/i.test(navigator.language || '') ? 'el' : 'en';
  })();
  const labelExpr = (lang) => lang === 'el'
    ? ['coalesce', ['get', 'name:el'], ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]
    : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
  const baseLabelIds = [];
  const extraSources = {
    'bm-sat': {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    'dem-hs': {
      type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen/AWS Terrain Tiles</a>',
    },
    'dem-3d': {
      type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    },
  };
  const extraLayers = [
    { id: 'bm-sat', type: 'raster', source: 'bm-sat', layout: { visibility: 'none' } },
    {
      id: 'hillshade', type: 'hillshade', source: 'dem-hs',
      paint: {
        'hillshade-exaggeration': dark ? 0.35 : 0.25,
        'hillshade-shadow-color': dark ? '#000000' : '#5a6475',
        'hillshade-highlight-color': dark ? '#3a4656' : '#ffffff',
      },
    },
  ];
  async function loadBaseStyle() {
    try {
      // a stalled tile server must not block the app: give up after 6 s and use the fallback
      const r = await fetch(`https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(r.status);
      const st = await r.json();
      for (const l of st.layers) {
        // every text label that shows a place name (road shields show "ref" numbers and are left alone)
        if (l.type === 'symbol' && l.layout && JSON.stringify(l.layout['text-field'] || '').includes('name')) {
          l.layout['text-field'] = labelExpr(labelLang);
          baseLabelIds.push(l.id);
        }
      }
      Object.assign(st.sources, extraSources);
      const [sat, hill] = extraLayers;
      // hill shading goes UNDER the sea: the elevation tiles include the seabed, which otherwise shows as rings offshore
      const water = st.layers.findIndex((l) => l['source-layer'] === 'water');
      st.layers.splice(water >= 0 ? water : 1, 0, hill);
      // satellite photo goes over the whole base map but under the place names
      const firstSym = st.layers.findIndex((l) => l.type === 'symbol');
      st.layers.splice(firstSym, 0, sat);
      return { style: st, labelsFrom: st.layers[firstSym + 1]?.id };
    } catch (err) {
      // fallback: plain grey basemap with no place names at all (never the outdated raster labels)
      return {
        style: {
          version: 8,
          glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
          sources: {
            'bm-light': {
              type: 'raster', tileSize: 256, maxzoom: 16,
              tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base'}/MapServer/tile/{z}/{y}/{x}`],
              attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors',
            },
            ...extraSources,
          },
          layers: [{ id: 'bm-light', type: 'raster', source: 'bm-light' }, ...extraLayers],
        },
        labelsFrom: undefined,
      };
    }
  }
  // data downloads start now, in parallel with the basemap request (they don't depend on it)
  const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
  const settle = (pr) => pr.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
  const evP = settle(getJSON('data/events.geojson'));
  const emsP = settle(getJSON('data/ems_index.json'));
  const wmsP = settle(getJSON('data/wms_layers.json'));
  const rgP = settle(getJSON('data/regions.geojson'));        // 330 KB, only needed for area shading
  const localP = settle(getJSON('data/local_floods.geojson')); // 740 KB, only shown zoomed in
  const { style, labelsFrom } = await loadBaseStyle();

  // read before the map is created: with hash:true the map writes its own camera into the URL right away
  const sharedView = /^#[\d.]+\/[-\d.]+\/[-\d.]+/.test(location.hash);
  const map = new maplibregl.Map({
    container: 'map', style, center: [23.6, 38.6], zoom: 5.6, minZoom: 4, maxZoom: 17,
    hash: true, maxPitch: 75,
    attributionControl: {
      compact: true,
      customAttribution: [
        'Floods: <a href="https://doi.org/10.5281/zenodo.23670886" target="_blank" rel="noopener">HANZE</a> (Paprotny, CC BY 4.0)',
        'Satellite flood maps © European Union, <a href="https://emergency.copernicus.eu/" target="_blank" rel="noopener">Copernicus EMS</a>',
        'Local reports &amp; flood zones: <a href="https://floods.ypeka.gr/" target="_blank" rel="noopener">Greek Ministry of Environment &amp; Energy</a>',
      ],
    },
  });
  if (new URLSearchParams(location.search).has('debug')) window.__map = map; // test hook, off for normal visitors
  class LayersControl {
    onAdd() {
      this._el = document.createElement('div');
      this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'maplibregl-ctrl-layers'; b.textContent = 'Layers';
      b.title = 'Choose what the map shows'; b.setAttribute('aria-controls', 'layers'); b.setAttribute('aria-expanded', 'false');
      b.style.color = '#333';
      b.onclick = () => openLayers(document.querySelector('#layers').hidden);
      this._btn = b; this._el.appendChild(b);
      return this._el;
    }
    onRemove() { this._el.remove(); }
  }
  const layersCtl = new LayersControl();
  map.addControl(layersCtl, 'top-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  // the base style references a few POI icons it doesn't ship; give MapLibre an empty image instead of a warning
  map.on('styleimagemissing', (e) => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');

  // 3D toggle as a map control
  class ThreeDControl {
    onAdd() {
      this._el = document.createElement('div');
      this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      this._btn = document.createElement('button');
      this._btn.type = 'button';
      this._btn.title = 'Toggle 3D terrain & extrusions';
      this._btn.className = 'ctrl-text';
      this._btn.textContent = '3D';
      this._btn.onclick = () => set3D(!state.is3d);
      this._el.appendChild(this._btn);
      this.sync();
      return this._el;
    }
    onRemove() { this._el.remove(); }
    // map controls stay white in dark mode, so the text colour must not inherit the page's light ink
    sync() {
      this._btn.classList.toggle('ctrl-on', state.is3d);
      this._btn.title = state.is3d ? '3D view is on: mountains and columns. Click for flat map.' : '3D view: mountains and columns';
      this._btn.setAttribute('aria-pressed', String(state.is3d));
    }
  }
  class HomeControl {
    onAdd() {
      this._el = document.createElement('div');
      this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '⌂'; b.title = 'Show all of Greece'; b.setAttribute('aria-label', 'Show all of Greece');
      b.className = 'ctrl-home'; b.onclick = () => goHome();
      this._el.appendChild(b);
      return this._el;
    }
    onRemove() { this._el.remove(); }
  }
  map.addControl(new HomeControl(), 'top-right');
  const threeD = new ThreeDControl();
  map.addControl(threeD, 'top-right');

  // ---------- slow orbit ("rotate") ----------
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const orbit = {
    on: false, raf: 0, last: 0, DEG_PER_SEC: 4,
    start() {
      if (this.on) return;
      if (!state.is3d) set3D(true);
      this.on = true; this.last = 0;
      const step = (t) => {
        if (!this.on) return;
        if (this.last && !map.isMoving()) map.setBearing(map.getBearing() + (Math.min(t - this.last, 100) / 1000) * this.DEG_PER_SEC);
        this.last = t;
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
      orbitCtl.sync();
    },
    stop() {
      if (!this.on) return;
      this.on = false; cancelAnimationFrame(this.raf);
      orbitCtl.sync();
    },
  };
  class OrbitControl {
    onAdd() {
      this._el = document.createElement('div');
      this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group ctrl-orbit';
      this._btn = document.createElement('button');
      this._btn.type = 'button';
      this._btn.onclick = () => (orbit.on ? orbit.stop() : orbit.start());
      this._el.appendChild(this._btn);
      this.sync();
      return this._el;
    }
    onRemove() { this._el.remove(); }
    sync() {
      if (!this._btn) return;
      this._btn.textContent = orbit.on ? '⏸ Pause' : '⟳ Rotate';
      this._btn.classList.add('ctrl-text');
      this._btn.classList.toggle('ctrl-on', orbit.on);
      this._btn.title = orbit.on ? 'Stop rotating' : 'Rotate the map slowly';
      this._btn.setAttribute('aria-label', this._btn.title);
      this._btn.setAttribute('aria-pressed', String(orbit.on));
    }
  }
  const orbitCtl = new OrbitControl();
  map.addControl(orbitCtl, 'top-right');
  // any hands-on interaction stops the orbit so it never fights the user
  let userMoved = false; // set once the user has touched the camera, so startup never overrides them
  for (const ev of ['mousedown', 'touchstart', 'wheel', 'dragstart']) map.on(ev, () => { userMoved = true; orbit.stop(); });
  for (const ev of ['rotatestart', 'pitchstart', 'zoomstart']) map.on(ev, (e) => { if (e.originalEvent) orbit.stop(); });
  map.getCanvasContainer().addEventListener('keydown', () => orbit.stop());

  // ---------- data loading ----------
  const ready = new Promise((res) => map.on('load', res));
  // credits start folded into the "i" button: expanded they wrap behind the timeline (full list is in About)
  map.on('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  // panels below the top card follow its real height (it grows with the headline and wraps on small screens)
  new ResizeObserver(() => document.documentElement.style.setProperty('--topcard-bottom', `${Math.round($('#topcard').getBoundingClientRect().bottom)}px`)).observe($('#topcard'));
  Promise.all([evP, emsP, wmsP, ready]).then(([ev, ems, wms]) => {
    if (ev.status === 'fulfilled') state.events = ev.value.features;
    else toast('Could not load the flood records. Please try reloading the page.');
    if (ems.status === 'fulfilled') state.ems = ems.value;
    if (wms.status === 'fulfilled') state.wms = (wms.value || []).filter((l) => l.verified);
    init();
    // the larger files arrive later and slot in
    rgP.then((rg) => { if (rg.status === 'fulfilled') addRegions(rg.value); });
    localP.then((local) => { if (local.status === 'fulfilled') addLocal(local.value.features); });
  });
  function addRegions(fcRegions) {
    state.regions = fcRegions;
    for (const r of fcRegions.features) state.regionBounds.set(r.properties.region_id, bboxOf(r.geometry));
    map.getSource('regions').setData(fcRegions);
    $('#l-regions').closest('label').hidden = false;
    updateRegions();
    if (state.selectedId) highlight(state.byId.get(state.selectedId)); // outline the selected flood's areas now
    renderLegend();
  }
  function addLocal(features) {
    state.local = features;
    for (const f of features) {
      const p = f.properties;
      localById.set(p.id, f);
      p._search = norm([p.place, p.place_en, p.basin, p.date].join(' '));
    }
    map.getSource('local').setData(fc(features));
    $('#l-local').closest('label').hidden = false;
    applyFilters();
  }

  function init() {
    // normalise
    for (const f of state.events) {
      const p = f.properties;
      p.fatalities = p.fatalities ?? 0;
      p.type = (p.type || 'other').toLowerCase();
      p._search = norm([p.name, p.place, p.storm, p.notes, p.cause, typeLabel(p.type), ...(p.rivers || []), ...(p.region_names || []), p.search_el, p.start_date]
        .join(' '));
      state.byId.set(p.id, f);
      state.types.add(p.type);
    }
    const ys = state.events.map((f) => f.properties.year).filter(Number.isFinite);
    state.years = ys.length ? [Math.min(...ys), Math.max(...ys)] : [1900, 2025];
    state.f.ymin = state.years[0]; state.f.ymax = state.years[1];
    state.f.types = new Set(state.types);

    const allDeaths = state.events.reduce((a, f) => a + (f.properties.fatalities || 0), 0);
    $('#hl-deaths').textContent = nf.format(allDeaths);
    $('#hl-floods').textContent = nf.format(state.events.length);
    $('#hl-since').textContent = state.years[0];
    document.body.classList.add('ready');
    addLayers();
    buildUI();
    // controls may have been used while the data was loading: start from what they show now
    state.f.fatal = $('#f-deadly').checked ? 1 : 0;
    state.f.q = norm($('#f-search').value.trim());
    state.choro = $('#choro').value;
    if (document.querySelector('input[name="bm"]:checked')?.value === 'sat') document.querySelector('input[name="bm"][value="sat"]').dispatchEvent(new Event('change'));
    if (!$('#l-local').checked) $('#l-local').dispatchEvent(new Event('change'));
    if ($('#l-ems').checked) $('#l-ems').dispatchEvent(new Event('change'));
    applyFilters();
    syncLayerVis(); // in case 3D was toggled while data was loading

    // open in 3D. A shared link (#zoom/lat/lon/bearing/pitch) keeps its camera; a flat shared view stays flat.
    if (!sharedView && !userMoved) {
      if (isPhone()) {
        goHome({ animate: false }); // flat: readable on a small screen, and no terrain download on mobile data
      } else {
        set3D(true, { camera: false });
        goHome({ animate: false });
        if (!reduceMotion) orbit.start();
      }
    } else if (map.getPitch() > 0 && !state.is3d) {
      set3D(true, { camera: false });
    }
  }

  function addLayers() {
    // official overlays go beneath data layers
    const byId = new Map(state.wms.map((l) => [l.id, l]));
    for (const it of OVERLAYS.flatMap((g) => g.items)) {
      const l = byId.get(it.id); if (!l) continue;
      map.addSource(`wms-${l.id}`, { type: 'raster', tiles: [l.url], tileSize: 256, attribution: l.attribution || '' });
      map.addLayer({
        id: `wms-${l.id}`, type: 'raster', source: `wms-${l.id}`, minzoom: it.minzoom || 0,
        layout: { visibility: 'none' }, paint: { 'raster-opacity': it.opacity ?? 0.75 },
      });
    }

    {
      map.addSource('regions', { type: 'geojson', data: fc([]), promoteId: 'region_id' });
      const vExpr = ['coalesce', ['feature-state', 'v'], 0];
      map.addLayer({
        id: 'regions-fill', type: 'fill', source: 'regions',
        paint: {
          'fill-color': ['interpolate', ['linear'], vExpr, 0, RAMP[0], 0.25, RAMP[1], 0.5, RAMP[2], 0.75, RAMP[3], 1, RAMP[4]],
          'fill-opacity': ['case', ['>', vExpr, 0], 0.55, 0],
        },
      });
      map.addLayer({
        id: 'regions-line', type: 'line', source: 'regions',
        paint: { 'line-color': dark ? '#5b6b80' : '#8796ab', 'line-width': 0.6, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'regions-sel', type: 'line', source: 'regions',
        paint: {
          'line-color': dark ? '#ffd43b' : '#1b2430',
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 2.2, 0],
        },
      });
    }

    // Ministry local flood reports: heat map when zoomed out, village dots when zoomed in
    map.addSource('local', { type: 'geojson', data: fc(state.local) });
    map.addLayer({
      id: 'local-pts', type: 'circle', source: 'local', minzoom: 7,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 10, 5, 13, 7],
        'circle-color': LOCAL_COLOR,
        'circle-opacity': 0.9,
        'circle-stroke-color': dark ? '#0f141a' : '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 1],
      },
    });

    // EMS extents (filled lazily)
    map.addSource('ems-ext', { type: 'geojson', data: fc([]) });
    const emsColor = ['case', ['==', ['slice', ['get', 'ems_code'], 0, 4], 'EMSN'], EMS_LATER_COLOR, EMS_COLOR];
    map.addLayer({ id: 'ems-ext-fill', type: 'fill', source: 'ems-ext', paint: { 'fill-color': emsColor, 'fill-opacity': 0.6 } });
    map.addLayer({ id: 'ems-ext-line', type: 'line', source: 'ems-ext', paint: { 'line-color': emsColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1.2] } });

    // events: 2D circles + 3D columns
    map.addSource('events', { type: 'geojson', data: fc(state.events) });
    map.addSource('event-cols', {
      type: 'geojson',
      data: fc(state.events.map((f) => ({ type: 'Feature', properties: f.properties, geometry: circlePoly(f.geometry.coordinates, 5.5) }))),
    });
    const colorExpr = FLOOD_COLOR;
    map.addLayer({
      id: 'event-cols', type: 'fill-extrusion', source: 'event-cols', layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': colorExpr,
        // columns are for the national/regional overview; past z8 they shrink and fade, flat markers take over
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
          7.4, ['+', 3000, ['*', ['sqrt', ['get', 'fatalities']], 11000]],
          8.2, ['+', 800, ['*', ['sqrt', ['get', 'fatalities']], 3000]]],
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 7.4, 0.9, 8.2, 0],
      },
    });
    map.addLayer({
      id: 'events', type: 'circle', source: 'events',
      paint: {
        'circle-color': colorExpr,
        'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'fatalities']], 0, 4.5, 2, 7, 5, 12, 8, 17],
        'circle-opacity': 0.82,
        'circle-stroke-color': dark ? '#0f141a' : '#ffffff',
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: 'events-hl', type: 'circle', source: 'events', filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': 20, 'circle-color': 'transparent', 'circle-stroke-color': dark ? '#ffd43b' : '#1b2430', 'circle-stroke-width': 2.5 },
    });

    // village dots above satellite areas (so they stay tappable inside a flooded area)
    map.moveLayer('local-pts', 'event-cols');
    // place names sit above area shading / satellite areas / official overlays, but below all markers
    for (const id of baseLabelIds) if (map.getLayer(id)) map.moveLayer(id, 'local-pts');

    // interactions
    for (const id of ['events', 'event-cols', 'ems-ext-fill', 'local-pts', 'regions-fill']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', (e) => {
      const z = map.getZoom();
      // some layers fade to opacity 0 instead of hiding; MapLibre still returns them, so skip the invisible ones
      const invisible = (id) => (id === 'event-cols' && z >= 8.2) || (id === 'events' && state.is3d && z < 7.9);
      const layers = ['events', 'event-cols', 'local-pts', 'ems-ext-fill', 'regions-fill'].filter(visible);
      // points are small: search a box around the tap (bigger for fingers) and take the nearest point
      const r = e.originalEvent?.pointerType === 'touch' || isPhone() ? 14 : 6;
      const box = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]];
      const near = (f) => { const c = pointCoords(f); if (!c) return Infinity; const q = map.project(c); return Math.hypot(q.x - e.point.x, q.y - e.point.y); };
      const pts = map.queryRenderedFeatures(box, { layers: layers.filter((l) => l === 'events' || l === 'event-cols' || l === 'local-pts') })
        .filter((h) => !invisible(h.layer.id));
      const flood = pts.filter((h) => h.layer.id !== 'local-pts').sort((a, b) => near(a) - near(b))[0];
      if (flood) {
        const id = flood.properties.id;
        const c = state.byId.get(id)?.geometry.coordinates;
        // several floods drawn at the same spot → let the user pick
        const ids = [...new Set(pts.filter((x) => x.layer.id !== 'local-pts').map((x) => x.properties.id))]
          .filter((x) => { const d = state.byId.get(x)?.geometry.coordinates; return d && c && d[0] === c[0] && d[1] === c[1]; });
        if (ids.length > 1) return popupMulti(ids, c);
        return selectEvent(id, { fly: false });
      }
      const local = pts.filter((h) => h.layer.id === 'local-pts').sort((a, b) => near(a) - near(b))[0];
      if (local) {
        const at = localById.get(local.properties.id)?.geometry.coordinates;
        const same = pts.filter((x) => x.layer.id === 'local-pts').map((x) => localById.get(x.properties.id))
          .filter((f) => f && at && f.geometry.coordinates[0] === at[0] && f.geometry.coordinates[1] === at[1])
          .map((f) => f.properties.id);
        return popupLocal([...new Set(same)], at);
      }
      const area = map.queryRenderedFeatures(e.point, { layers: layers.filter((l) => l === 'ems-ext-fill' || l === 'regions-fill') })[0];
      if (area?.layer.id === 'ems-ext-fill') return popupExtent(area.properties); // areas: no ring
      if (area) return popupRegion(area.properties.region_id);
      closePopup(); // clicked empty map: clear the selection
    });
    // desktop hover: name, year and deaths of a flood without clicking
    const tip = $('#tip');
    for (const id of ['events', 'event-cols']) {
      map.on('mousemove', id, (e) => {
        const f = e.features?.[0]; if (!f || (id === 'event-cols' && map.getZoom() >= 8.2) || (id === 'events' && state.is3d && map.getZoom() < 7.9)) return;
        const p = state.byId.get(f.properties.id)?.properties; if (!p) return;
        tip.textContent = `${p.name} · ${p.year} · ${p.fatalities ? plural(p.fatalities, 'death') : 'no deaths recorded'}`;
        tip.style.left = `${e.point.x + 14}px`; tip.style.top = `${e.point.y + 14}px`; tip.hidden = false;
      });
      map.on('mouseleave', id, () => { tip.hidden = true; });
    }
    map.on('movestart', () => { tip.hidden = true; });
  }

  // ---------- UI ----------
  function buildUI() {
    const types = [...state.types].sort((a, b) => countType(b) - countType(a));
    $('#f-types').innerHTML = types.map((t) =>
      `<button type="button" class="chip" data-t="${esc(t)}" aria-pressed="true">${esc(typeLabel(t))} <span class="muted">${countType(t)}</span></button>`).join('');
    $('#f-types').addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      const t = b.dataset.t, on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      on ? state.f.types.delete(t) : state.f.types.add(t);
      applyFilters();
    });

    const [y0, y1] = state.years;
    for (const el of [$('#f-ymin'), $('#f-ymax')]) { el.min = y0; el.max = y1; }
    $('#f-ymin').value = y0; $('#f-ymax').value = y1;
    const onYears = () => {
      let a = +$('#f-ymin').value || y0, b = +$('#f-ymax').value || y1;
      if (a > b) [a, b] = [b, a];
      state.f.ymin = a; state.f.ymax = b; applyFilters();
    };
    let yt;
    for (const el of [$('#f-ymin'), $('#f-ymax')]) {
      el.addEventListener('change', onYears);
      el.addEventListener('input', () => { clearTimeout(yt); yt = setTimeout(() => { if (String(el.value).length === 4) onYears(); }, 400); });
    }
    $('#f-yreset').addEventListener('click', () => setYears(y0, y1));

    let t, ft;
    $('#f-search').addEventListener('input', (e) => {
      clearTimeout(t); clearTimeout(ft);
      orbit.stop();
      t = setTimeout(() => {
        state.f.q = norm(e.target.value.trim());
        applyFilters();
        if (state.f.q && !isPhone()) openDrawer(true); // searching shows the matching floods
        ft = setTimeout(flyToResults, 450);           // and, once typing pauses, moves the map to them
      }, 150);
    });
    $('#f-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // open the flood whose own name matches (e.g. "Mandra"), or the only result
      const byName = state.filtered.filter((f) => norm(f.properties.name).includes(state.f.q));
      const pick = state.filtered.length === 1 ? state.filtered[0] : byName.length === 1 ? byName[0] : null;
      if (pick && state.f.q) selectEvent(pick.properties.id, { fly: true });
      else { flyToResults(); if (state.f.q) openDrawer(true); }
    });
    $('#fs-clear').addEventListener('click', () => { clearFilters(); goHome(); });
    $('#btn-home').addEventListener('click', () => goHome());
    $('#stories').addEventListener('click', (e) => {
      const b = e.target.closest('[data-story]'); if (b) story(b.dataset.story);
    });
    $('#f-deadly').addEventListener('change', (e) => { state.f.fatal = e.target.checked ? 1 : 0; applyFilters(); });
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

    const vis = (ids, on) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    $('#l-events').addEventListener('change', syncLayerVis);
    $('#l-regions').addEventListener('change', () => { syncLayerVis(); renderLegend(); });
    $('#l-local').addEventListener('change', (e) => { vis(['local-pts'], e.target.checked); renderLegend(); });
    $('#l-local').closest('label').hidden = true;   // shown when the file arrives (addLocal)
    // "Land under water, seen by satellite": all flooded areas at once (single floods can also be opened from a popup)
    $('#l-ems').addEventListener('change', async (e) => {
      emsGen++;
      state.emsAll = e.target.checked;
      if (!e.target.checked) { state.emsLoaded.clear(); refreshExtents(); renderLegend(); syncEmsButtons(); return; }
      const msg = `Loading ${state.ems.length} satellite flood maps…`;
      toast(msg);
      await Promise.all(state.ems.map((a) => loadExtent(a.code, false)));
      if ($('#toast').textContent === msg) toast(''); // don't wipe an error shown meanwhile
      renderLegend();
    });
    $('#choro').addEventListener('change', (e) => { state.choro = e.target.value; updateRegions(); renderLegend(); });
    document.querySelectorAll('input[name="bm"]').forEach((r) => r.addEventListener('change', (e) => {
      const sat = e.target.value === 'sat';
      vis(['bm-sat'], sat); vis(['bm-light'], !sat);
    }));
    // place-name language
    if (!baseLabelIds.length) $('#lang-seg').hidden = true;
    const langInput = document.querySelector(`input[name="lang"][value="${labelLang}"]`);
    if (langInput) langInput.checked = true;
    document.querySelectorAll('input[name="lang"]').forEach((r) => r.addEventListener('change', (e) => {
      labelLang = e.target.value;
      for (const id of baseLabelIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'text-field', labelExpr(labelLang));
      try { localStorage.setItem(LABEL_LANG_KEY, labelLang); } catch {}
    }));

    // drawer, layers panel, about dialog
    $('#btn-list').addEventListener('click', () => openDrawer($('#drawer').hidden));
    $('#drawer-close').addEventListener('click', () => openDrawer(false));
    $('#layers-close').addEventListener('click', () => openLayers(false));
    $('#btn-about').addEventListener('click', () => $('#about').showModal());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#about').open) { closePopup(); openDrawer(false); openLayers(false); } });
    if (matchMedia('(max-width: 700px)').matches) $('#legend-box').open = false;

    if (!state.ems.length) $('#l-ems').closest('label').hidden = true;
    $('#l-regions').closest('label').hidden = true; // shown when the file arrives (addRegions)

    const have = new Set(state.wms.map((l) => l.id));
    $('#wms-list').innerHTML = OVERLAYS.map((g) => {
      const items = g.items.filter((it) => have.has(it.id));
      if (!items.length) return '';
      return `<details><summary>${esc(g.group)}</summary>${items.map((it) =>
        `<label><input type="checkbox" data-wms="${esc(it.id)}"> ${esc(it.title)}</label>`).join('')}</details>`;
    }).join('');
    $('#wms-list').addEventListener('change', (e) => {
      const id = e.target.dataset.wms; if (id) vis([`wms-${id}`], e.target.checked);
    });

    buildTimeline();
    renderLegend();
  }

  function syncLayerVis() {
    const ev = $('#l-events').checked, rg = $('#l-regions').checked, d3 = state.is3d;
    const set = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    set('events', ev); set('events-hl', ev); set('event-cols', ev && d3);
    // in 3D the flat markers only appear once zoomed in (columns fade out over the same range)
    if (map.getLayer('events')) {
      map.setPaintProperty('events', 'circle-opacity', d3 ? ['interpolate', ['linear'], ['zoom'], 7.9, 0, 8.3, 0.82] : 0.82);
      map.setPaintProperty('events', 'circle-stroke-opacity', d3 ? ['interpolate', ['linear'], ['zoom'], 7.9, 0, 8.3, 1] : 1);
    }
    // region shading always stays flat (drapes over terrain in 3D): raised flat-topped regions cut through mountains
    set('regions-fill', rg); set('regions-line', rg);
  }

  function set3D(on, { camera = true } = {}) {
    state.is3d = on;
    if (isPhone()) on ? map.touchPitch.enable() : map.touchPitch.disable();
    if (on) {
      map.setTerrain({ source: 'dem-3d', exaggeration: 1.6 });
      if (camera) map.easeTo({ pitch: 58, bearing: -18, duration: 1200 });
    } else {
      orbit.stop();
      map.setTerrain(null);
      if (camera) map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
    }
    syncLayerVis();
    threeD.sync();
    renderLegend();
  }

  // ---------- filtering ----------
  function filtersActive() {
    const f = state.f;
    return !!(f.q || f.fatal || f.ymin !== state.years[0] || f.ymax !== state.years[1] || f.types.size !== state.types.size);
  }
  function passesExcept(p, skip) {
    const f = state.f;
    if (skip !== 'type' && !f.types.has(p.type)) return false;
    if ((p.fatalities || 0) < f.fatal) return false;
    if (p.year < f.ymin || p.year > f.ymax) return false;
    if (f.q && !p._search.includes(f.q)) return false;
    return true;
  }
  function clearFilters() {
    state.f.q = ''; $('#f-search').value = '';
    state.f.fatal = 0; $('#f-deadly').checked = false;
    state.f.ymin = state.years[0]; state.f.ymax = state.years[1];
    state.f.types = new Set(state.types);
    document.querySelectorAll('#f-types .chip').forEach((b) => b.setAttribute('aria-pressed', 'true'));
    applyFilters();
  }
  function passes(p, ignoreYears = false) {
    const f = state.f;
    if (!f.types.has(p.type)) return false;
    if ((p.fatalities || 0) < f.fatal) return false;
    if (!ignoreYears && (p.year < f.ymin || p.year > f.ymax)) return false;
    if (f.q && !p._search.includes(f.q)) return false;
    return true;
  }

  function applyFilters() {
    state.filtered = state.events.filter((f) => passes(f.properties));
    const ids = state.filtered.map((f) => f.properties.id);
    const flt = ['in', ['get', 'id'], ['literal', ids]];
    for (const id of ['events', 'event-cols']) map.getLayer(id) && map.setFilter(id, flt);
    // local reports have no death counts and no flood type: they follow the year range and search only,
    // and are hidden when a minimum number of deaths is asked for
    const f = state.f;
    const localIds = f.fatal > 0 ? [] : state.local.filter((x) => {
      const p = x.properties;
      return (p.year == null || (p.year >= f.ymin && p.year <= f.ymax)) && (!f.q || p._search.includes(f.q));
    }).map((x) => x.properties.id);
    state.localShown = localIds.length;
    for (const id of ['local-pts']) map.getLayer(id) && map.setFilter(id, ['in', ['get', 'id'], ['literal', localIds]]);
    const lc = document.querySelector('#local-count');
    if (lc) lc.textContent = state.local.length ? `(${nf.format(localIds.length)})` : '';

    if (state.selectedId && !state.filtered.some((f) => f.properties.id === state.selectedId)) { closePopup(); }
    const fatal = state.filtered.reduce((s, f) => s + (f.properties.fatalities || 0), 0);
    // headline = the whole story; this line says what the filters currently show
    const active = filtersActive();
    $('#filter-status').hidden = !active;
    if (active) {
      const parts = [`${plural(state.filtered.length, 'major flood')} (${plural(fatal, 'death')})`];
      if (state.local.length && f.fatal === 0) parts.push(plural(localIds.length, 'village report'));
      $('#fs-text').textContent = `Showing ${parts.join(' · ')}${state.f.ymin !== state.years[0] || state.f.ymax !== state.years[1] ? `, ${state.f.ymin}–${state.f.ymax}` : ''}`;
    }
    $('#timeline').classList.toggle('years-filtered', state.f.ymin !== state.years[0] || state.f.ymax !== state.years[1]);
    if (document.activeElement !== $('#f-ymin')) $('#f-ymin').value = state.f.ymin;
    if (document.activeElement !== $('#f-ymax')) $('#f-ymax').value = state.f.ymax;
    // type buttons count what the other filters leave
    document.querySelectorAll('#f-types .chip').forEach((b) => {
      const t = b.dataset.t;
      const n = state.events.filter((x) => x.properties.type === t && passesExcept(x.properties, 'type')).length;
      b.querySelector('.muted').textContent = n;
    });

    updateRegions();
    renderList();
    drawTimeline();
    renderLegend();
  }

  function updateRegions() {
    if (!state.regions) return;
    const agg = new Map();
    for (const f of state.filtered) {
      for (const r of f.properties.region_ids || []) {
        const a = agg.get(r) || { count: 0, fatal: 0 };
        a.count++; a.fatal += f.properties.fatalities || 0;
        agg.set(r, a);
      }
    }
    const key = state.choro === 'fatal' ? 'fatal' : 'count';
    const max = Math.max(1, ...[...agg.values()].map((a) => a[key]));
    state.choroMax = max;
    for (const r of state.regions.features) {
      const id = r.properties.region_id, a = agg.get(id) || { count: 0, fatal: 0 };
      // sqrt scaling keeps a single extreme region from washing out the rest
      map.setFeatureState({ source: 'regions', id }, { count: a.count, fatal: a.fatal, v: a[key] ? Math.sqrt(a[key] / max) : 0 });
    }
  }

  // move the map to what the search found (major floods + village reports)
  function flyToResults() {
    if (!state.f.q || state.f.q.length < 3) return;
    const pts = state.filtered.map((f) => f.geometry.coordinates);
    for (const f of state.local) if (f.properties._search.includes(state.f.q) && passesLocalYears(f.properties)) pts.push(f.geometry.coordinates);
    if (!pts.length || pts.length > 80) return;
    const bb = [[Math.min(...pts.map((c) => c[0])), Math.min(...pts.map((c) => c[1]))], [Math.max(...pts.map((c) => c[0])), Math.max(...pts.map((c) => c[1]))]];
    map.fitBounds(bb, { padding: mapPadding(), maxZoom: 10.5, duration: 900, pitch: state.is3d ? 50 : 0 });
  }
  const passesLocalYears = (p) => p.year == null || (p.year >= state.f.ymin && p.year <= state.f.ymax);
  // "Start here" buttons: each tells one part of the story
  function story(name) {
    orbit.stop();
    if (name !== 'since2000') clearFilters();
    if (name === 'daniel') {
      const ev = state.events.find((f) => f.properties.storm === 'Storm Daniel');
      if (!ev) return;
      selectEvent(ev.properties.id, { fly: true });
      const a = relatedEms(ev.properties).find((x) => !isFollowUp(x));
      if (a) loadExtent(a.code, false).then(() => syncEmsButtons());
    } else if (name === 'deadliest') {
      state.sort = 'fatal'; $('#sort').value = 'fatal'; renderList();
      if (!isPhone()) openDrawer(true);
      const top = [...state.events].sort((a, b) => (b.properties.fatalities || 0) - (a.properties.fatalities || 0))[0];
      if (top) selectEvent(top.properties.id, { fly: true });
    } else if (name === 'athens') {
      closePopup();
      if (!$('#l-local').checked) $('#l-local').click();
      map.fitBounds([[23.45, 37.85], [24.05, 38.2]], { padding: mapPadding(), pitch: state.is3d ? 45 : 0, duration: 1000 });
    } else if (name === 'since2000') {
      clearFilters(); setYears(2000, state.years[1]); goHome();
    }
  }
  function setYears(a, b) { state.f.ymin = a; state.f.ymax = b; applyFilters(); }

  // ---------- list ----------
  function renderList() {
    const arr = [...state.filtered];
    const key = { date: (p) => p.start_date || String(p.year), fatal: (p) => p.fatalities || 0, affected: (p) => p.persons_affected || 0 }[state.sort];
    arr.sort((a, b) => {
      const x = key(a.properties), y = key(b.properties);
      return x < y ? 1 : x > y ? -1 : 0;
    });
    $('#list-count').textContent = `(${nf.format(arr.length)})`;
    const LIM = 300;
    $('#list').innerHTML = arr.slice(0, LIM).map((f) => {
      const p = f.properties;
      const right = p.fatalities ? plural(p.fatalities, 'death') : p.persons_affected ? `${nfc.format(p.persons_affected)} affected` : '';
      return `<li data-id="${esc(p.id)}" tabindex="0"${p.id === state.selectedId ? ' class="active"' : ''}><i style="background:${typeColor(p.type)}"></i>
        <div><div class="t">${esc(shortName(p))}</div><div class="d">${esc(fmtDate(p.start_date))}${p.storm ? '' : ' · ' + esc(typeLabel(p.type))}</div></div>
        <div class="n">${right}</div></li>`;
    }).join('') + (arr.length > LIM ? `<li class="more">Showing ${LIM} of ${arr.length}. Search or pick years to narrow down.</li>` : '')
      + (arr.length ? '' : '<li class="more">No major floods match. <button class="link" type="button" data-clear>Clear filters</button></li>');
  }
  $('#list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = e.target.closest('li[data-id]'); if (li) { e.preventDefault(); li.click(); }
  });
  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('[data-clear]')) { clearFilters(); return; }
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (isPhone()) openDrawer(false);
    selectEvent(li.dataset.id, { fly: true });
  });

  // ---------- selection & popups ----------
  const localById = new Map();
  // Details open in a card (right side on desktop, bottom sheet on phones), not a map popup: popups live inside
  // the map's stacking context and would sit under the floating cards. A small pin marks the clicked spot.
  const pinEl = document.createElement('div'); pinEl.className = 'pin';
  const pin = new maplibregl.Marker({ element: pinEl });
  let infoOpener = null;
  // lngLat = the point to ring (a flood or village report); null for areas, which get no ring
  function openPopup(lngLat, html) {
    const info = $('#info');
    if (info.hidden) infoOpener = document.activeElement;
    clearCardExtents();
    info.innerHTML = `<button class="icon-btn info-close" type="button" aria-label="Close details">×</button>${html}`;
    info.hidden = false; info.scrollTop = 0;
    openLayers(false);
    if (isPhone()) openDrawer(false);
    orbit.stop();
    if (lngLat) pin.setLngLat(lngLat).addTo(map); else pin.remove();
  }
  function closePopup() {
    pin.remove(); highlight(null); clearCardExtents();
    const info = $('#info'); if (info.hidden) return;
    info.hidden = true;
    if (infoOpener && document.contains(infoOpener)) infoOpener.focus?.();
  }
  // satellite areas shown from a details card belong to that card (unless "all satellite maps" is switched on)
  function clearCardExtents() {
    if (state.emsAll || !state.emsLoaded.size) return;
    emsGen++; state.emsLoaded.clear(); refreshExtents(); renderLegend();
  }
  $('#info').addEventListener('click', (e) => {
    if (e.target.closest('.info-close')) return closePopup();
    onPopupClick(e);
  });

  function onPopupClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, arg } = b.dataset;
    if (act === 'ems') {
      // toggle: show (and zoom to) this satellite map, or hide it again
      if (state.emsLoaded.has(arg)) { state.emsLoaded.delete(arg); refreshExtents(); renderLegend(); }
      else loadExtent(arg, true).then(() => syncEmsButtons());
      syncEmsButtons();
    }
    if (act === 'event') selectEvent(arg, { fly: true });
  }

  function highlight(ev) {
    for (const id of state.selectedRegions) map.setFeatureState({ source: 'regions', id }, { sel: false });
    state.selectedRegions = [];
    document.querySelectorAll('#list li.active').forEach((li) => li.classList.remove('active'));
    state.selectedId = ev ? ev.properties.id : null;
    if (!ev) { map.getLayer('events-hl') && map.setFilter('events-hl', ['==', ['get', 'id'], '']); return; }
    const p = ev.properties;
    map.setFilter('events-hl', ['==', ['get', 'id'], p.id]);
    if (state.regions) {
      for (const id of p.region_ids || []) { map.setFeatureState({ source: 'regions', id }, { sel: true }); state.selectedRegions.push(id); }
    }
    const li = document.querySelector(`#list li[data-id="${CSS.escape(p.id)}"]`);
    if (li) { li.classList.add('active'); li.scrollIntoView({ block: 'nearest' }); }
  }

  function selectEvent(id, { fly, at } = {}) {
    const ev = state.byId.get(id); if (!ev) return;
    orbit.stop();
    const p = ev.properties;
    // open the details first so the zoom below leaves room for the card
    openPopup(at || ev.geometry.coordinates, eventHTML(p));
    highlight(ev);
    if (fly) {
      const bb = unionBounds((p.region_ids || []).map((r) => state.regionBounds.get(r)).filter(Boolean));
      if (bb) map.fitBounds(bb, { padding: mapPadding(), maxZoom: 9, duration: 900, pitch: state.is3d ? 55 : 0 });
      else map.flyTo({ center: ev.geometry.coordinates, zoom: 8, padding: mapPadding() });
    }
  }

  // one plain sentence: "River flood on 4–7 Sep 2023 that killed 17 people and affected 5,260."
  function summary(p) {
    const what = p.storm ? `${p.storm} brought a ${typeLabel(p.type).toLowerCase()}` : `A ${typeLabel(p.type).toLowerCase()}`;
    const harm = [p.fatalities ? `killed ${plural(p.fatalities, 'person').replace('persons', 'people')}` : 'killed no one on record',
      p.persons_affected ? `affected ${nf.format(p.persons_affected)} ${p.persons_affected === 1 ? 'person' : 'people'}` : null].filter(Boolean);
    const rain = cause(p.cause);
    return `${what} on ${fmtRange(p)} that ${harm.join(' and ')}.${rain && /mm/.test(rain) ? ` ${rain}.` : ''}`;
  }
  // "Heavy rainfall up to 754 mm in 21 h" -> "Up to 754 mm of rain fell in 21 hours"
  function cause(c) {
    if (!c) return '';
    const m = c.match(/up to ([\d.,]+) mm in ([\d.]+) ?(h|days?)/i);
    if (m) return `Up to ${m[1]} mm of rain fell in ${m[2]} ${m[3].toLowerCase() === 'h' ? (m[2] === '1' ? 'hour' : 'hours') : m[3]}`;
    return c;
  }
  function eventHTML(p) {
    const rows = [
      p.storm && ['Type', esc(typeLabel(p.type))],
      ['Deaths', p.fatalities ? nf.format(p.fatalities) : 'None recorded'],
      p.persons_affected != null && ['People affected', `${nf.format(p.persons_affected)}<div class="muted">evacuated, injured or left homeless</div>`],
      p.area_inundated_km2 != null && ['Land under water', `${nf.format(p.area_inundated_km2)} km²`],
      p.losses_eur != null && ['Damage', `${euros(p.losses_eur)} <span class="muted">(2025 prices)</span>`],
      p.cause && ['Cause', esc(cause(p.cause))],
      (p.rivers || []).length && [p.rivers.length > 1 ? 'Rivers' : 'River', esc(p.rivers.join(', '))],
      (p.region_names || []).length && ['Areas hit', esc(p.region_names.join(', '))],
    ].filter(Boolean);
    const related = relatedEms(p);
    const sub = p.storm ? fmtRange(p) : `${typeLabel(p.type)} · ${fmtRange(p)}`;
    return `<div class="pp">
      <h3>${esc(p.name)}</h3>
      <div class="dt">${esc(sub)}</div>
      <p class="summary">${esc(summary(p))}</p>
      ${related.map((a) => {
        const what = isFollowUp(a) ? 'land still under water weeks later' : 'flooded area seen by satellite';
        const on = state.emsLoaded.has(a.code);
        return `<button class="btn${isFollowUp(a) ? ' later' : ''}" data-act="ems" data-arg="${esc(a.code)}" data-what="${what}" aria-pressed="${on}">${on ? 'Hide' : 'Show'} ${what}</button>`;
      }).join('')}
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
      ${p.references ? `<details><summary>Sources</summary><div>${linkify(p.references)}</div></details>` : ''}
      <div class="src">Source: HANZE European flood database (record ${esc(String(p.id).replace('HANZE-', ''))})</div>
    </div>`;
  }


  function syncEmsButtons() {
    document.querySelectorAll('#info [data-act="ems"]').forEach((b) => {
      const on = state.emsLoaded.has(b.dataset.arg);
      b.textContent = (on ? 'Hide ' : 'Show ') + b.dataset.what;
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function popupMulti(ids, lngLat) {
    const items = ids.map((id) => state.byId.get(id).properties).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
    openPopup(lngLat, `<div class="pp"><h3>${items.length} major floods hit this same area</h3>
      <div class="dt">They are drawn on the same spot. Pick one:</div>
      ${items.map((p) => `<button class="btn" data-act="event" data-arg="${esc(p.id)}">${esc(fmtDate(p.start_date))}${p.fatalities ? ' · ' + plural(p.fatalities, 'death') : ''}</button>`).join('')}</div>`);
  }

  function popupExtent(p) {
    const a = state.ems.find((x) => x.code === p.ems_code);
    const evs = a ? relatedEvents(a) : [];
    openPopup(null, `<div class="pp">
      <h3>${String(p.ems_code).startsWith('EMSN') ? 'Still under water weeks later' : 'Land under water, seen by satellite'}</h3>
      <div class="dt">${a ? esc(emsTitle(a)) : ''}</div>
      <table>
        ${p.obs_date ? `<tr><td>Satellite image taken</td><td>${esc(fmtDate(p.obs_date))}</td></tr>` : ''}
        ${p.product ? `<tr><td>Map type</td><td>${esc(PRODUCT_LABEL[p.product] || p.product)}</td></tr>` : ''}
        ${a && a.area_km2 != null ? `<tr><td>Total flooded land mapped</td><td>${nf.format(Math.round(a.area_km2 * 10) / 10)} km²</td></tr>` : ''}
      </table>
      ${evs.map((e) => `<button class="btn" data-act="event" data-arg="${esc(e.id)}">See deaths and damage</button>`).join('')}
      ${a && a.url ? `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Original maps (Copernicus) ↗</a>` : ''}
    </div>`);
  }

  function popupLocal(ids, lngLat) {
    const byId = new Map(state.local.map((f) => [f.properties.id, f.properties]));
    const items = ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
    if (!items.length) return;
    const one = (p) => `
      <table>
        <tr><td>Date</td><td>${esc(fmtDate(p.date) || 'unknown')}</td></tr>
        ${(p.impacts || []).length ? `<tr><td>Damage</td><td>${p.impacts.map(esc).join('<br>')}</td></tr>` : ''}
        <tr><td>Emergency services</td><td>${p.civil_protection ? 'Called out' : 'Not called out'}</td></tr>
        <tr><td>River basin</td><td>${esc(p.basin || '')}</td></tr>
      </table>`;
    const p0 = items[0];
    const title = `${esc(p0.place)}${p0.place_en && p0.place_en !== p0.place ? ` <span class="muted">(${esc(p0.place_en)})</span>` : ''}`;
    openPopup(lngLat, `<div class="pp">
      <h3>${title}</h3>
      <div class="dt">${items.length > 1 ? `${items.length} village flood reports here` : 'Village flood report'} · Ministry records, 2012–2018</div>
      ${items.slice(0, 4).map(one).join('<hr>')}
      ${items.length > 4 ? `<div class="notes muted">and ${items.length - 4} more reports</div>` : ''}
      <div class="src">Source: Greek Ministry of Environment &amp; Energy, records for the national flood-risk plans</div>
    </div>`);
  }

  function popupRegion(id) {
    const r = state.regions?.features.find((f) => f.properties.region_id === id); if (!r) return;
    const evs = state.filtered.filter((f) => (f.properties.region_ids || []).includes(id))
      .map((f) => f.properties).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
    const fatal = evs.reduce((s, p) => s + (p.fatalities || 0), 0);
    const filtered = state.filtered.length !== state.events.length;
    openPopup(null, `<div class="pp">
      <h3>${esc(r.properties.name)}</h3>
      <div class="dt">${evs.length ? `${plural(evs.length, 'major flood')}, ${plural(fatal, 'death')}` : 'No major floods recorded'}${filtered ? ' (with current filters)' : ''}</div>
      ${evs.slice(0, 12).map((p) => `<button class="btn" data-act="event" data-arg="${esc(p.id)}">${esc(fmtDate(p.start_date))}${p.fatalities ? ' · ' + plural(p.fatalities, 'death') : ''}</button>`).join('')}
      ${evs.length > 12 ? `<div class="notes muted">and ${evs.length - 12} more in the list</div>` : ''}
    </div>`);
  }

  // ---------- EMS extents ----------
  let emsGen = 0; // bumped whenever the loaded set is reset, so late downloads don't resurrect cleared shapes
  async function loadExtent(code, zoom) {
    const gen = emsGen;
    if (zoom) orbit.stop();
    const a = state.ems.find((x) => x.code === code); if (!a || !a.file) return;
    if (!state.emsLoaded.has(code)) {
      try {
        const g = await getJSON(`data/${a.file}`);
        if (gen !== emsGen) return;
        state.emsLoaded.set(code, g.features.map((f) => ({ ...f, properties: { ...f.properties, ems_code: code } })));
        refreshExtents();
      } catch (err) { toast(`Could not load ${code}`); return; }
    }
    renderLegend();
    if (zoom && a.bbox) map.fitBounds([[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]], { padding: mapPadding(), maxZoom: 11, duration: 900, pitch: state.is3d ? 55 : 0 });
  }
  function refreshExtents() { map.getSource('ems-ext').setData(fc([...state.emsLoaded.values()].flat())); }

  // match HANZE events ↔ EMS activations: date proximity + spatial proximity
  function relatedEms(p) {
    if (p.ems_code) return state.ems.filter((a) => a.code === p.ems_code);
    const ev = state.byId.get(p.id); if (!ev || !p.start_date || p.start_date.length < 10) return [];
    const t0 = Date.parse(p.start_date), t1 = Date.parse(p.end_date || p.start_date);
    return state.ems.filter((a) => {
      if (!a.event_date || !a.centroid) return false;
      const t = Date.parse(a.event_date);
      if (t < t0 - 3 * 864e5 || t > t1 + 10 * 864e5) return false;
      const inRegion = (p.region_ids || []).some((r) => { const b = state.regionBounds.get(r); return b && a.centroid[0] >= b[0][0] - 0.3 && a.centroid[0] <= b[1][0] + 0.3 && a.centroid[1] >= b[0][1] - 0.3 && a.centroid[1] <= b[1][1] + 0.3; });
      return inRegion || km(ev.geometry.coordinates, a.centroid) < 200;
    });
  }
  function relatedEvents(a) {
    return state.events.map((f) => f.properties).filter((p) => relatedEms(p).some((x) => x.code === a.code));
  }

  // ---------- timeline ----------
  let tl = null;
  function buildTimeline() {
    const svg = $('#tl-svg');
    let drag = null;
    const yearAt = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = Math.min(Math.max(0, ev.clientX - r.left), r.width);
      const [y0, y1] = state.years;
      return Math.min(y1, Math.max(y0, Math.round(y0 + (x / r.width) * (y1 - y0 + 1) - 0.5)));
    };
    let x0 = 0, moved = false;
    svg.addEventListener('pointerdown', (e) => { drag = yearAt(e); x0 = e.clientX; moved = false; try { svg.setPointerCapture(e.pointerId); } catch {} });
    svg.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      if (!moved && Math.abs(e.clientX - x0) < 6) return; // a tap or a shaky finger doesn't filter to one year
      moved = true;
      const y = yearAt(e); setYears(Math.min(drag, y), Math.max(drag, y));
    });
    svg.addEventListener('pointerup', () => { drag = null; });
    svg.addEventListener('dblclick', () => setYears(...state.years));
    new ResizeObserver(drawTimeline).observe(svg);
    tl = svg;
  }
  function drawTimeline() {
    if (!tl) return;
    const [y0, y1] = state.years, n = y1 - y0 + 1;
    const counts = new Array(n).fill(0);
    for (const f of state.events) if (passes(f.properties, true)) counts[f.properties.year - y0]++;
    const W = tl.clientWidth || 600, H = tl.clientHeight || 68, AX = 12;
    tl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const max = Math.max(1, ...counts), bw = W / n;
    let s = '';
    const sx = ((state.f.ymin - y0) / n) * W, sw = ((state.f.ymax - state.f.ymin + 1) / n) * W;
    if (state.f.ymin > y0 || state.f.ymax < y1) s += `<rect class="sel" x="${sx}" y="0" width="${sw}" height="${H - AX}"/>`;
    counts.forEach((c, i) => {
      if (!c) return;
      const h = Math.max(2, (c / max) * (H - AX - 4)), y = y0 + i;
      const on = y >= state.f.ymin && y <= state.f.ymax;
      s += `<rect class="bar${on ? ' on' : ''}" x="${i * bw + 0.5}" y="${H - AX - h}" width="${Math.max(1, bw - 1)}" height="${h}"><title>${y}: ${c} major flood${c > 1 ? 's' : ''}</title></rect>`;
    });
    const step = n > 100 ? 20 : n > 40 ? 10 : 5;
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      s += `<text class="axis" x="${((y - y0 + 0.5) / n) * W}" y="${H - 1}" text-anchor="middle">${y}</text>`;
    }
    tl.innerHTML = s;
  }

  // ---------- legend ----------
  function renderLegend() {
    const label = state.choro === 'fatal' ? 'Deaths in each area' : 'Major floods in each area';
    const max = state.choroMax || 1;
    const showLocal = state.local.length && $('#l-local').checked && !state.f.fatal;
    const codes = [...state.emsLoaded.keys()];
    const first = codes.some((c) => !/^EMSN/.test(c)), later = codes.some((c) => /^EMSN/.test(c));
    $('#legend').innerHTML = `
      <div class="lg-row"><span class="sw" style="background:${FLOOD_COLOR}"></span><b>Major flood</b></div>
      <div class="lg-row muted lg-indent">${state.is3d ? 'taller column (or bigger circle) = more deaths' : 'bigger circle = more deaths'}</div>
      <div class="lg-row muted lg-indent">drawn in the middle of the area it hit</div>
      ${showLocal ? `<div class="lg-row"><span class="sw" style="background:${LOCAL_COLOR};width:8px;height:8px;margin:0 2px"></span><span>Village flood report, 2012–2018 <span class="muted">(zoom in)</span></span></div>` : ''}
      ${first ? `<div class="lg-row"><span class="sw sq" style="background:${EMS_COLOR}"></span>Under water, seen by satellite</div>` : ''}
      ${later ? `<div class="lg-row"><span class="sw sq" style="background:${EMS_LATER_COLOR}"></span>Still under water weeks later</div>` : ''}
      ${state.regions && $('#l-regions').checked ? `<div class="lg-title">${label}</div>
        <div class="ramp" style="background:linear-gradient(90deg,${RAMP.join(',')})"></div>
        <div class="ramp-l"><span>few</span><span>${nf.format(max)}</span></div>` : ''}`;
  }


  // ---------- home view ----------
  const GREECE = [[19.3, 34.7], [28.4, 41.8]]; // mainland, islands and Crete
  function goHome({ animate = true } = {}) {
    closePopup();
    // fit flat first, then tilt: fitting a tilted view zooms out far more than needed
    const cam = map.cameraForBounds(GREECE, { padding: mapPadding() });
    if (!cam) return;
    const view = { center: cam.center, zoom: cam.zoom + (state.is3d ? 0.3 : 0), pitch: state.is3d ? 50 : 0, bearing: state.is3d ? -12 : 0 };
    animate ? map.easeTo({ ...view, duration: 900 }) : map.jumpTo(view);
  }

  // ---------- floating panels ----------
  const isPhone = () => matchMedia('(max-width: 700px)').matches;
  const openers = {};
  function openDrawer(on) {
    const d = $('#drawer');
    if (on === !d.hidden) return;
    if (on && isPhone()) { openLayers(false); closePopup(); } // one bottom sheet at a time on phones
    if (on) { openers.drawer = document.activeElement; orbit.stop(); }
    d.hidden = !on;
    $('#btn-list').setAttribute('aria-expanded', String(on));
    $('#btn-list').textContent = on ? '✕ Hide list' : '☰ All floods';
    // move keyboard focus in, and back to where it came from — but never steal it from the search box
    if (on && document.activeElement !== $('#f-search')) $('#sort').focus();
    if (!on && d.contains(document.activeElement)) openers.drawer?.focus?.();
  }
  function openLayers(on) {
    const l = $('#layers');
    if (on === !l.hidden) return;
    if (on) { if (isPhone()) openDrawer(false); closePopup(); openers.layers = document.activeElement; orbit.stop(); }
    l.hidden = !on;
    layersCtl._btn?.setAttribute('aria-expanded', String(on));
    if (on) l.querySelector('input:checked, input')?.focus();
    if (!on && l.contains(document.activeElement)) openers.layers?.focus?.();
  }
  // keep zoomed-to features clear of the floating cards
  function mapPadding() {
    const rect = (sel) => { const el = $(sel); return el && !el.hidden ? el.getBoundingClientRect() : null; };
    const top = rect('#topcard'), tl = rect('#timeline'), info = rect('#info');
    const bottomGap = innerHeight - Math.min(tl ? tl.top : innerHeight, info && isPhone() ? info.top : innerHeight);
    if (isPhone()) return { top: (top ? top.bottom : 0) + 10, bottom: bottomGap + 10, left: 20, right: 20 };
    return { top: 40, bottom: bottomGap + 20, left: (top ? top.right : 0) + 20, right: info ? innerWidth - info.left + 20 : 70 };
  }

  // ---------- helpers ----------
  function pointCoords(f) {
    const id = f.properties.id;
    return (state.byId.get(id) || localById.get(id))?.geometry.coordinates;
  }
  function fc(features) { return { type: 'FeatureCollection', features }; }
  function visible(id) { return map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none'; }
  function countType(t) { return state.events.filter((f) => f.properties.type === t).length; }
  function shortName(p) {
    const n = p.name || p.place || 'Flood';
    return n.length > 80 ? n.slice(0, 78) + '…' : n;
  }
  function fmtDate(d) {
    if (!d) return '';
    const [y, m, dd] = String(d).split('-');
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return dd ? `${+dd} ${M[m - 1]} ${y}` : m ? `${M[m - 1]} ${y}` : y;
  }
  function linkify(s) {
    // references are joined with "; " and each has a year in brackets: "Author (2020) Title. <https://…>"
    const refs = String(s).split(/;\s(?=[^;]*?\(\d{4}[a-z]?\))/);
    const LINK = /<?(https?:\/\/[^\s>]+|doi:\s?10\.[^\s>]+)>?/g;
    return refs.map((r) => {
      const urls = [...r.matchAll(LINK)].map((m) => m[1].startsWith('doi:') ? `https://doi.org/${m[1].slice(4).trim()}` : m[1]);
      const text = esc(r.replace(LINK, '').replace(/\s+([.,])/g, '$1').trim());
      return text + urls.map((u) => ` <a href="${esc(u)}" target="_blank" rel="noopener">open ↗</a>`).join('');
    }).join('<br>');
  }
  function plural(n, word) { return `${nf.format(n)} ${word}${n === 1 ? '' : 's'}`; }
  function euros(v) {
    if (v >= 1e9) return `€${(v / 1e9).toFixed(1).replace(/\.0$/, '')} billion`;
    if (v >= 1e6) return `€${(v / 1e6).toFixed(1).replace(/\.0$/, '')} million`;
    return `€${nf.format(Math.round(v))}`;
  }
  function fmtRange(p) {
    const a = p.start_date, b = p.end_date;
    if (!b || b === a) return fmtDate(a);
    const [ya, ma] = a.split('-'), [yb, mb] = b.split('-');
    if (ya === yb && ma === mb && a.length === 10 && b.length === 10) return `${+a.slice(8)}–${fmtDate(b)}`;
    return `${fmtDate(a)} – ${fmtDate(b)}`;
  }
  // "EMSR692 Flood in Thessaly" style names -> "Flood in Thessaly, Sep 2023"
  // Copernicus names are inconsistent ("Flood in Attika- Greece", "Floods in Thessaly Region- Greece")
  function emsPlace(a) {
    let n = String(a.name || '').replace(/^EMSR\d+\s*[-–:]?\s*/i, '').trim()
      .replace(/\s*[,\-–]\s*Greece\s*$/i, '')
      .replace(/^(flash\s+)?floods?\s+((in|on|at)\s+(the\s+)?)?/i, '')
      .replace(/\s+regions?\b/i, '').replace(/\bAttika\b/g, 'Attica').trim();
    if (!n || /^greece$/i.test(n)) n = '';
    return n ? n[0].toUpperCase() + n.slice(1) : '';
  }
  function emsStorm(a) { return relatedEvents(a).map((p) => p.storm).find(Boolean) || null; }
  // popup title: "Storm Daniel, Sep 2023" / "Flooding in Thessaly, Sep 2020"
  // EMSN… products are Copernicus "risk & recovery" maps made weeks after the event, not first-response maps
  const isFollowUp = (a) => /^EMSN/i.test(a.code);
  function emsTitle(a) {
    const yr = a.event_date ? fmtDate(a.event_date.slice(0, 7)) : '';
    const place = emsPlace(a);
    const directional = /^(north|south|east|west)/i.test(place); // "west of Athens" reads without "in"
    const head = emsStorm(a) || (place ? `Flooding ${directional ? place[0].toLowerCase() + place.slice(1) : 'in ' + place}` : 'Flooding in Greece');
    if (isFollowUp(a)) return `${head}: land still under water weeks later`;
    return yr ? `${head}, ${yr}` : head;
  }
  // short map label: "Storm Daniel · Sep 2023" / "Thessaly · Sep 2020"
  function emsShort(a) {
    const yr = a.event_date ? fmtDate(a.event_date.slice(0, 7)) : '';
    const head = emsStorm(a) || emsPlace(a) || 'Greece';
    if (isFollowUp(a)) return `${head} · weeks later`;
    return yr ? `${head} · ${yr}` : head;
  }

  function circlePoly([lon, lat], rKm, n = 24) {
    const dLat = rKm / 111.32, dLon = rKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    const ring = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
    return { type: 'Polygon', coordinates: [ring] };
  }
  function bboxOf(g) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    const walk = (x) => { if (typeof x[0] === 'number') { a = Math.min(a, x[0]); b = Math.min(b, x[1]); c = Math.max(c, x[0]); d = Math.max(d, x[1]); } else x.forEach(walk); };
    walk(g.coordinates);
    return [[a, b], [c, d]];
  }
  function unionBounds(list) {
    if (!list.length) return null;
    return [[Math.min(...list.map((x) => x[0][0])), Math.min(...list.map((x) => x[0][1]))], [Math.max(...list.map((x) => x[1][0])), Math.max(...list.map((x) => x[1][1]))]];
  }
  function km([a, b], [c, d]) {
    const R = 6371, r = Math.PI / 180, x = (c - a) * r * Math.cos(((b + d) / 2) * r), y = (d - b) * r;
    return R * Math.hypot(x, y);
  }
  let toastT;
  function toast(msg) {
    const el = $('#toast'); clearTimeout(toastT);
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg; el.hidden = false; toastT = setTimeout(() => (el.hidden = true), 4000);
  }
})();
