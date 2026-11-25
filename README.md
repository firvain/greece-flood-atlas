# Greece Flood Atlas

Interactive 3D web map of floods in Greece. Live at **https://firvain.github.io/greece-flood-atlas/**.

- **Major floods, 1887–2025:** 121 events from the HANZE database, with deaths, people affected, damage, cause and rivers. Each one is located by the areas (NUTS3) it hit.
- **Local flood reports, 2012–2018:** 2,331 village-level records from the Greek Ministry of Environment & Energy (Floods Directive GeoServer).
- **Satellite flood maps:** land seen under water in 16 Copernicus EMS activations in Greece (2015–2026), including Storm Daniel, Medicane Ianos and Mandra.
- **Official flood zones:** Ministry flood hazard and risk maps (50, 100 and 1,000-year floods, water depth, risk), plus Copernicus EFAS/GloFAS models (live WMS overlays).
- **Basemap:** OpenStreetMap vector tiles (OpenFreeMap), with place names in English or Greek. Terrain comes from AWS Terrain Tiles.

## Layout
```
web/                 the static site (MapLibre GL JS 4.7.1, no build step) — this folder is what gets published
  data/              generated data files (see DATA_CONTRACT.md)
pipeline/            Python (uv) scripts that download and process the data → web/data/
  build_hanze.py     HANZE events + NUTS3 regions (uses labels.py for plain-language names)
  build_ems.py       Copernicus EMS flood extents
  build_ypen.py      Ministry local flood reports
data/raw/            cached downloads (git-ignored, ~600 MB)
.github/workflows/   GitHub Pages deployment of web/
```

## Rebuild the data
```bash
uv run --project pipeline python pipeline/build_hanze.py
uv run --project pipeline python pipeline/build_ems.py      # --refresh to pick up new activations
uv run --project pipeline python pipeline/build_ypen.py
```
`web/data/wms_layers.json` (verified overlay endpoints) was compiled by hand. `data/raw/wms/NOTES.md` explains how it was put together.

## Run locally
```bash
cd web && python3 -m http.server 8000     # open http://localhost:8000  (add ?debug to expose window.__map)
```

## Publish
Every push to `main` deploys `web/` to GitHub Pages (`.github/workflows/pages.yml`).

## Sources and licences
- Paprotny, D. (2026) *HANZE database of historical flood impacts in Europe, 1870–2025*, v3.0.2 beta. doi:10.5281/zenodo.23670886, **CC BY 4.0**.
- Satellite flood maps: © European Union, Copernicus Emergency Management Service.
- Local flood reports and flood zones: Greek Ministry of Environment & Energy, Special Secretariat for Water (floods.ypeka.gr). The service lists no fees and no access constraints.
- EFAS / GloFAS flood hazard: Copernicus EMS / JRC.
- Base map: © OpenStreetMap contributors (ODbL), OpenMapTiles, OpenFreeMap. Satellite photo: Esri, Maxar, Earthstar Geographics (attribution required; Esri terms apply to commercial use). Terrain: Mapzen / AWS Terrain Tiles.

## Caveats
- HANZE lists only significant floods that have impact data, and it locates them by area, not by town. v3 is a beta release.
- The Ministry's local reports cover 2012–2018 only. Some river basins publish extra older or newer records in different formats that are not yet included (see the `build_ypen.py` notes).
