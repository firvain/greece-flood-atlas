"""Build the Greek flood-event catalogue from HANZE.

Outputs (see DATA_CONTRACT.md sections 1 and 2):
  web/data/events.geojson   - Point per Greek flood event (centroid of affected NUTS3 regions)
  web/data/regions.geojson  - Greek NUTS3 (v2024) polygons with per-region event stats

Source: HANZE (Paprotny et al.), Zenodo concept record 17226475, resolved to the latest
version at build time (falls back to the pinned version below if the API is unreachable
but files are cached).

Run from repo root:
  uv run --project pipeline python pipeline/build_hanze.py
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import geopandas as gpd

import labels  # noqa: E402  (pipeline/labels.py, plain-language names)
import pandas as pd
import requests
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "hanze"
OUT = ROOT / "web" / "data"

CONCEPT_RECORD = "17226475"
ZENODO_API = "https://zenodo.org/api/records"
# Pinned fallback (used when the API is unreachable but files are cached).
PINNED = {"record": "23670886", "version": "v3.0.2 beta"}

COUNTRY = "EL"  # HANZE uses Eurostat codes: Greece = EL
METRIC_CRS = "EPSG:2100"  # GGRS87 / Greek Grid
SIMPLIFY_M = 100.0

# File-name patterns (version-agnostic) of the files we need from the record.
FILE_PATTERNS = {
    "events": re.compile(r"^HANZE_events_.*\.csv$"),
    "references": re.compile(r"^HANZE_references_.*\.csv$"),
    "region_names": re.compile(r"^S\d+a?_regions_codes_and_names_v2024\.csv$"),
    "regions_map": re.compile(r"^Regions_v2024_simplified\.zip$"),
}


# --------------------------------------------------------------------------- download
def resolve_latest() -> tuple[str, str, list[dict]]:
    """Return (record_id, version_string, files) of the latest version of the concept record."""
    r = requests.get(f"{ZENODO_API}/{CONCEPT_RECORD}/versions/latest", timeout=60)
    r.raise_for_status()
    d = r.json()
    return str(d["id"]), d["metadata"].get("version", ""), d["files"]


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print(f"  downloading {dest.name}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    tmp.rename(dest)
    return dest


def download() -> tuple[str, dict[str, Path]]:
    RAW.mkdir(parents=True, exist_ok=True)
    meta_path = RAW / "record.json"
    try:
        rec_id, version, files = resolve_latest()
        meta_path.write_text(
            json.dumps({"record": rec_id, "version": version, "files": files}, indent=1)
        )
    except requests.RequestException as exc:
        if not meta_path.exists():
            raise
        print(f"  Zenodo API unreachable ({exc}); using cached record.json")
        m = json.loads(meta_path.read_text())
        rec_id, version, files = m["record"], m["version"], m["files"]
    print(f"HANZE record {rec_id} ({version})")

    paths: dict[str, Path] = {}
    for key, pat in FILE_PATTERNS.items():
        match = [f for f in files if pat.match(f["key"])]
        if not match:
            raise SystemExit(f"No file matching {pat.pattern} in record {rec_id}")
        f = match[0]
        paths[key] = fetch(f["links"]["self"], RAW / f["key"])
    return version, paths


# --------------------------------------------------------------------------- helpers
def source_label(version: str) -> str:
    # "v3.0.2 beta" -> "HANZE v3.0.2 beta"
    v = version.strip() or PINNED["version"]
    return f"HANZE {v}" if v.startswith("v") else f"HANZE v{v}"


def none_if_nan(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, str) and not v.strip():
        return None
    return v


def to_int(v):
    v = none_if_nan(v)
    return None if v is None else int(round(float(v)))


def to_float(v, nd=2):
    v = none_if_nan(v)
    return None if v is None else round(float(v), nd)


def norm_date(v) -> str | None:
    """Return YYYY-MM-DD / YYYY-MM / YYYY depending on available precision."""
    v = none_if_nan(v)
    if v is None:
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", s)
    if not m:
        return None
    y, mo, d = m.groups()
    if d:
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    if mo:
        return f"{y}-{int(mo):02d}"
    return y


TYPE_MAP = {"river": "river", "flash": "flash", "coastal": "coastal", "pluvial": "pluvial"}


def norm_type(v) -> str | None:
    v = none_if_nan(v)
    if v is None:
        return None
    parts = [p.strip().lower() for p in str(v).split("/") if p.strip()]
    if len(parts) > 1:
        return "compound"  # e.g. "River / Coastal"
    return TYPE_MAP.get(parts[0], parts[0])


def split_list(v) -> list[str]:
    v = none_if_nan(v)
    if v is None:
        return []
    return [p.strip() for p in str(v).split(";") if p.strip()]


def round_coords(geom_dict: dict, nd: int = 5) -> dict:
    def rnd(c):
        if isinstance(c, (list, tuple)):
            if c and isinstance(c[0], (int, float)):
                return [round(c[0], nd), round(c[1], nd)]
            return [rnd(x) for x in c]
        return c

    return {"type": geom_dict["type"], "coordinates": rnd(geom_dict["coordinates"])}


def write_fc(path: Path, features: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fc = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# --------------------------------------------------------------------------- build
def build_references(path: Path) -> dict[str, str]:
    refs = pd.read_csv(path, encoding="utf-8-sig", dtype=str)
    out = {}
    for _, r in refs.iterrows():
        key = (r.get("source_author_year") or "").strip()
        if not key:
            continue
        text = (none_if_nan(r.get("source_name")) or key).strip()
        url = none_if_nan(r.get("source_url"))
        out[key] = f"{text} <{url.strip()}>" if url else text
    return out


def main() -> int:
    version, paths = download()
    src = source_label(version)

    ev = pd.read_csv(paths["events"], encoding="utf-8-sig")
    ev = ev[ev["country_code"] == COUNTRY].copy()
    if ev.empty:
        raise SystemExit(f"No events with country_code == {COUNTRY}")
    ev = ev.sort_values(["start_date", "id"]).reset_index(drop=True)
    print(f"Greek events: {len(ev)}")

    unit_years = sorted(ev["admin_unit_year"].dropna().astype(int).unique().tolist())
    if unit_years != [2024]:
        print(f"  WARNING: events use region vintages {unit_years}; map is v2024")

    ref_lookup = build_references(paths["references"])

    names_tbl = pd.read_csv(paths["region_names"], encoding="utf-8-sig", dtype=str)
    name_lookup = dict(zip(names_tbl["Code"], names_tbl["Name"]))

    regions = gpd.read_file(f"zip://{paths['regions_map']}")
    regions = regions[regions["Code"].str.startswith(COUNTRY)].copy()
    regions = regions.to_crs(METRIC_CRS)
    regions = regions.dissolve(by="Code", as_index=False, aggfunc="first")
    geom_by_code = dict(zip(regions["Code"], regions.geometry))
    if "Name" in regions:
        for c, n in zip(regions["Code"], regions["Name"]):
            name_lookup.setdefault(c, n)

    # ---- events
    unresolved: dict[str, list] = {}
    unresolved_refs: set[str] = set()
    features = []
    stats: dict[str, dict] = {c: {"n": 0, "fat": 0, "years": []} for c in geom_by_code}

    for _, r in ev.iterrows():
        codes = split_list(r["admin_unit_code"])
        geoms = []
        for c in codes:
            if c in geom_by_code:
                geoms.append(geom_by_code[c])
            else:
                unresolved.setdefault(c, []).append(int(r["id"]))
        if not geoms:
            print(f"  event {r['id']}: no resolvable region, skipped")
            continue
        union = unary_union(geoms)
        pt = union.centroid
        if not union.contains(pt):
            pt = union.representative_point()
        pt_wgs = gpd.GeoSeries([pt], crs=METRIC_CRS).to_crs(4326).iloc[0]

        region_names = [labels.region_name(c, name_lookup.get(c)) for c in codes]
        rivers = split_list(r.get("event_source"))
        hanze_notes = none_if_nan(r.get("notes"))
        storm = labels.storm_name(hanze_notes, none_if_nan(r.get("cause")))
        ev_type = norm_type(r["event_type"])
        name = labels.event_title(ev_type, codes, storm)

        start = norm_date(r["start_date"])
        end = norm_date(r["end_date"])
        year = int(r["event_start_date_year"]) if none_if_nan(r.get("event_start_date_year")) is not None else int(start[:4])
        month = int(start[5:7]) if start and len(start) >= 7 else None

        fat = to_int(r["casualty_count"])
        loss_eur = to_float(r["economic_loss_value_eur"], 0)
        losses_note = None
        if loss_eur is not None:
            ref_year = to_int(r.get("reference_year_eur"))
            losses_note = f"in {ref_year} euros, adjusted for inflation"

        ref_keys = split_list(r.get("sources_author_year"))
        ref_texts = []
        for k in ref_keys:
            if k in ref_lookup:
                ref_texts.append(ref_lookup[k])
            else:
                unresolved_refs.add(k)
                ref_texts.append(k)

        notes = labels.clean_note(hanze_notes)

        props = {
            "id": f"HANZE-{int(r['id'])}",
            "source": src,
            "name": name,
            "start_date": start,
            "end_date": end,
            "year": year,
            "month": month,
            "type": ev_type,
            "type_label": labels.TYPE_LABEL.get(ev_type or "", "Flood"),
            "place": labels.place_label(codes, max_names=3),
            "storm": storm,
            "rivers": rivers,
            "fatalities": fat,
            "persons_affected": to_int(r["ppl_affected"]),
            "area_inundated_km2": to_float(r["area_affected"], 2),
            "losses_eur": loss_eur,
            "losses_note": losses_note,
            "region_ids": codes,
            "region_names": region_names,
            "search_el": " ".join(labels.REGION_NAMES_EL.get(c, "") for c in codes),
            "cause": none_if_nan(r.get("cause")),
            "notes": notes,
            "references": "; ".join(ref_texts) or None,
            "ems_code": None,
        }
        features.append(
            {
                "type": "Feature",
                "geometry": round_coords({"type": "Point", "coordinates": [pt_wgs.x, pt_wgs.y]}),
                "properties": props,
            }
        )
        for c in set(codes):
            if c in stats:
                stats[c]["n"] += 1
                stats[c]["fat"] += fat or 0
                stats[c]["years"].append(year)

    write_fc(OUT / "events.geojson", features)

    # ---- regions
    reg = regions.copy()
    reg["geometry"] = reg.geometry.simplify(SIMPLIFY_M, preserve_topology=True)
    reg = reg.to_crs(4326)
    reg_features = []
    for _, r in reg.sort_values("Code").iterrows():
        s = stats[r["Code"]]
        geom = r.geometry.__geo_interface__
        reg_features.append(
            {
                "type": "Feature",
                "geometry": round_coords(geom),
                "properties": {
                    "region_id": r["Code"],
                    "name": labels.region_name(r["Code"], name_lookup.get(r["Code"])),
                    "name_official": name_lookup.get(r["Code"], r["Code"]),
                    "search_el": labels.REGION_NAMES_EL.get(r["Code"], ""),
                    "event_count": s["n"],
                    "fatalities_total": s["fat"],
                    "first_year": min(s["years"]) if s["years"] else None,
                    "last_year": max(s["years"]) if s["years"] else None,
                },
            }
        )
    write_fc(OUT / "regions.geojson", reg_features)

    # ---- report
    print(f"source: {src}")
    print(f"events written: {len(features)}; regions written: {len(reg_features)}")
    if unresolved:
        print(f"UNRESOLVED region ids: {unresolved}")
    else:
        print("all event region ids resolved")
    if unresolved_refs:
        print(f"references not found in references table ({len(unresolved_refs)}): {sorted(unresolved_refs)}")
    for p in ("events.geojson", "regions.geojson"):
        print(f"  {p}: {(OUT / p).stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
