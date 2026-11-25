# Data contract (pipeline → web)

All outputs live in `web/data/`, are WGS84 (EPSG:4326) GeoJSON, coordinates rounded to 5 decimals.
Raw downloads go in `data/raw/<source>/` (never committed). Scripts live in `pipeline/` and run with
`uv run --project pipeline python pipeline/<script>.py` from the repo root.

## 1. `web/data/events.geojson` — flood event catalogue (HANZE, Greece only)
FeatureCollection of **Point** features (centroid of the union of affected regions).

| property | type | notes |
|---|---|---|
| `id` | string | stable id, e.g. `HANZE-<original id>` |
| `source` | string | `"HANZE v3"` (exact version string) |
| `name` | string | human-readable label, e.g. `"Mandra, Attica"` or best available location text |
| `start_date` | string | `YYYY-MM-DD` (use `YYYY-MM` / `YYYY` precision if that's all there is) |
| `end_date` | string\|null | |
| `year` | int | |
| `month` | int\|null | |
| `type` | string | flood type as given by source, normalised to lowercase (`river`, `flash`, `coastal`, `compound`, ...) |
| `fatalities` | int\|null | |
| `persons_affected` | int\|null | |
| `area_inundated_km2` | number\|null | |
| `losses_eur` | number\|null | nominal or inflation-adjusted — state which in `losses_note` |
| `losses_note` | string\|null | |
| `region_ids` | string[] | NUTS3 (or whatever region code HANZE uses) ids affected |
| `region_names` | string[] | |
| `cause` | string\|null | |
| `notes` | string\|null | free-text description if present |
| `references` | string\|null | source citations, joined with `; ` |
| `ems_code` | string\|null | Copernicus EMS activation code if the event matches one (left null by HANZE step) |

## 2. `web/data/regions.geojson` — region polygons used by HANZE, Greece only
**Polygon/MultiPolygon**, simplified (~100 m tolerance) so the file stays < 2 MB.

| property | type |
|---|---|
| `region_id` | string (matches `region_ids` above) |
| `name` | string |
| `event_count` | int |
| `fatalities_total` | int |
| `first_year` | int\|null |
| `last_year` | int\|null |

## 3. Copernicus EMS flood extents
- `web/data/ems_index.json` — JSON array, one object per Greek flood activation:
  `{ "code": "EMSR692", "name": "...", "event_date": "YYYY-MM-DD", "activation_date": "YYYY-MM-DD",
     "bbox": [minx,miny,maxx,maxy], "centroid": [lon,lat], "url": "<activation page>",
     "file": "ems/EMSR692.geojson", "n_features": 123, "area_km2": 456.7 }`
- `web/data/ems/<CODE>.geojson` — **Polygon/MultiPolygon** observed flood extent for that activation
  (dissolved per AOI is fine), simplified so each file is < 3 MB. Properties:
  `ems_code`, `aoi` (AOI name/number), `product` (e.g. `delineation`, `grading`, `monitoring`),
  `obs_date` (`YYYY-MM-DD` of the satellite image if known), `area_km2`.

## 4. `web/data/wms_layers.json` — optional official overlay layers (Floods Directive etc.)
JSON array: `{ "id", "title", "type": "wms"|"xyz", "url", "layers", "format", "attribution", "verified": true, "notes" }`
Only include endpoints that were actually verified to return imagery for Greece.

## 5. `web/data/local_floods.geojson` — Ministry local flood reports (2012–2018)
**Point** features, one per community-level record. Properties: `id` (`YPEN-<fid>`), `date` (`YYYY-MM-DD`|null), `year`,
`place` (Greek, cleaned), `place_en` (Latin transliteration), `basin` (river basin district, English),
`impacts` (string[]: "Damage to roads and infrastructure", "Damage to homes and property", "Farmland affected", "People harmed"),
`civil_protection` (bool), `people_harmed` (bool).

## Extra fields added for the UI
- events: `type_label`, `place`, `storm`, `rivers[]`, `search_el` (Greek names for search); `name` is a plain-language title.
- regions: `name` is a common English name, `name_official` is the Eurostat name, and `search_el` holds Greek names.
