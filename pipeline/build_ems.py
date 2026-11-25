"""Build Copernicus EMS flood-extent layers for Greece.

Outputs (see DATA_CONTRACT.md section 3):
  web/data/ems_index.json
  web/data/ems/<CODE>.geojson

Sources
  * Activation catalogue (all CEMS activations, 2012-today):
      https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=2000
  * Activations handled by the current Rapid Mapping portal (~EMSR656+):
      https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=<CODE>
    -> per-product layer list; the observedEventA layer is fetched as GeoJSON from the
       public viewer bucket (rapidmapping-viewer.s3...), falling back to the product zip.
  * Older activations: the activation page
      https://mapping.emergency.copernicus.eu/activations/<CODE>/
    links the legacy "*_vector.zip" packages on cems-mapping-website.s3...

Downloaded files are treated as untrusted data: they are only opened with zipfile /
geopandas (pyogrio) and never executed.

Run from repo root:
  uv run --project pipeline python pipeline/build_ems.py [--refresh]
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
import shapely
from shapely.geometry import mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "ems"
WEB = ROOT / "web" / "data"
OUT_DIR = WEB / "ems"

CATALOGUE_URL = "https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=2000"
RM_API = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code={code}"
PAGE_URL = "https://mapping.emergency.copernicus.eu/activations/{code}/"
SITE = "https://mapping.emergency.copernicus.eu"

FLOOD_CATEGORIES = {"flood", "storm"}  # storm-driven floods are sometimes filed as storms
METRIC_CRS = 3035  # ETRS89-LAEA: equal-area, metres
MAX_BYTES = 3_000_000
# (simplification tolerance in m, minimum polygon-part / hole area in m2), tried in order
# until the file is < MAX_BYTES
LADDER = [(15, 0), (15, 1000), (20, 2500), (20, 5000), (25, 10000), (30, 20000),
          (40, 40000), (60, 80000), (90, 150000), (130, 300000)]
UA = {"User-Agent": "greece-floods-pipeline/0.1 (research; python-requests)"}

session = requests.Session()
session.headers.update(UA)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- http


def get(url: str, *, stream=False, timeout=120, tries=4, ok404=False):
    last = None
    for i in range(tries):
        try:
            r = session.get(url, stream=stream, timeout=timeout, allow_redirects=True)
            if r.status_code == 200:
                return r
            if r.status_code in (401, 403, 404) and ok404:
                return None
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:  # noqa: PERF203
            last = repr(e)
        time.sleep(2 * (i + 1))
    if ok404:
        log(f"   ! giving up on {url}: {last}")
        return None
    raise RuntimeError(f"GET {url} failed: {last}")


def download(url: str, dest: Path) -> Path | None:
    """Cached streaming download."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = get(url, stream=True, timeout=600, ok404=True)
    if r is None:
        return None
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    tmp.rename(dest)
    log(f"   downloaded {dest.relative_to(ROOT)} ({dest.stat().st_size / 1e6:.1f} MB)")
    return dest


def cached_json(url: str, dest: Path, refresh: bool):
    if dest.exists() and not refresh:
        return json.loads(dest.read_text())
    r = get(url, ok404=True)
    if r is None:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data))
    return data


def cached_text(url: str, dest: Path, refresh: bool) -> str | None:
    if dest.exists() and not refresh:
        return dest.read_text()
    r = get(url, ok404=True)
    if r is None:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(r.text)
    return r.text


# --------------------------------------------------------------------------- model


@dataclass
class Unit:
    """One downloadable product (map sheet) for one AOI."""

    aoi_num: int
    aoi_name: str
    kind: str  # DEL | GRA | FEP
    monit: int  # 0 = initial product
    version: int
    sheet: str  # map sheet id (legacy detail maps), "" otherwise
    url: str
    is_zip: bool
    obs_dates: list[str] = field(default_factory=list)

    @property
    def key(self):
        return (self.aoi_num, self.kind, self.monit, self.sheet)


@dataclass
class Activation:
    code: str
    name: str
    event_date: str | None
    activation_date: str
    url: str
    units: list[Unit] = field(default_factory=list)
    note: str = ""


MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
MON_RE = "(" + "|".join(MONTHS) + "|" + "|".join(m[:3] for m in MONTHS) + r")\.?"


def parse_event_date(text: str, activation: date) -> str | None:
    """Earliest plausible date (<= activation, within 60 days) mentioned in the reason text."""
    if not text:
        return None
    t = text.lower()
    found: list[date] = []

    def add(y, m, d):
        try:
            found.append(date(int(y), int(m), int(d)))
        except ValueError:
            pass

    for d, m, y in re.findall(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b", t):
        add(y, m, d)
    for d, mon, y in re.findall(r"\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+" + MON_RE + r"(?:,?\s+(\d{4}))?", t):
        add(y or activation.year, MONTHS.get(mon) or MONTHS[[k for k in MONTHS if k.startswith(mon)][0]], d)
    for mon, d, y in re.findall(MON_RE + r"\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?", t):
        add(y or activation.year, MONTHS.get(mon) or MONTHS[[k for k in MONTHS if k.startswith(mon)][0]], d)
    ok = [f for f in found if 0 <= (activation - f).days <= 60]
    return min(ok).isoformat() if ok else None


# --------------------------------------------------------------------------- discovery


def discover(refresh: bool) -> list[dict]:
    cat = cached_json(CATALOGUE_URL, RAW / "_catalogue.json", refresh)
    res = cat["results"]
    log(f"catalogue: {len(res)} activations")
    greek = [
        a for a in res
        if any(c.get("short_name") == "Greece" for c in a.get("countries", []))
        and a.get("category", {}).get("slug") in FLOOD_CATEGORIES
    ]
    greek.sort(key=lambda a: a["activationTime"])
    return greek


def from_rapidmapping(meta: dict, rm: dict) -> Activation:
    code = rm["code"]
    act = Activation(
        code=code,
        name=rm.get("name") or meta["name"],
        event_date=(rm.get("eventTime") or "")[:10] or None,
        activation_date=(rm.get("activationTime") or meta["activationTime"])[:10],
        url=PAGE_URL.format(code=code),
    )
    for aoi in rm.get("aois", []):
        num = int(aoi["number"])
        for p in aoi.get("products", []):
            if not p.get("feasible", True):
                continue
            kind = p["type"]
            monit = int(p.get("monitoringNumber") or 0) if p.get("monitoring") else 0
            tag = f"AOI{num:02d}_{kind}_" + (f"MONIT{monit:02d}" if monit else "PRODUCT")
            layers = [
                l for l in p.get("layers") or []
                if re.search(rf"{tag}_observedEventA_v\d+", l.get("name", ""))
                and l.get("json")
            ]
            version = int((p.get("version") or {}).get("number") or 1)
            dates = sorted({i["acquisitionTime"][:10] for i in p.get("images") or [] if i.get("acquisitionTime")})
            if layers:
                url, is_zip = layers[0]["json"], False
            elif p.get("downloadPath") and layers == [] and any(
                "bservedEventA" in l.get("name", "") and tag in l.get("name", "") for l in p.get("layers") or []
            ):
                url, is_zip = p["downloadPath"], True
            else:
                continue  # no observed-event vector for this product
            act.units.append(Unit(num, aoi["name"], kind, monit, version, "", url, is_zip, dates))
    return act


LEGACY_NEW = re.compile(
    r"^(?P<code>EMS[RN]\d+)_AOI(?P<aoi>\d+)_(?P<kind>DEL|GRA|FEP)_(?:PRODUCT|MONIT(?P<monit>\d+))_r\d+_\w+?_v(?P<ver>\d+)_vector\.zip$"
)
LEGACY_OLD = re.compile(
    r"^(?P<code>EMS[RN]\d+)_(?P<aoi>\d{2})(?P<aoiname>[A-Z0-9]+)_(?:\d{2})?(?P<kind>DELINEATION|GRADING|REFERENCE)_(?P<part>.+?)_v(?P<ver>\d+)_vector\.zip$"
)
KIND_MAP = {"DELINEATION": "DEL", "GRADING": "GRA", "REFERENCE": "REF"}


def from_legacy_page(meta: dict, page: str) -> Activation:
    code = meta["code"]
    act_date = meta["activationTime"][:10]
    m = re.search(r"Activation Reason</span><br/>(.*?)</p>", page, re.S)
    reason = html.unescape(re.sub(r"<[^>]+>", " ", m.group(1))).strip() if m else ""
    text = reason + " " + (meta.get("search_snippet") or "")
    ev = parse_event_date(text, date.fromisoformat(act_date))
    act = Activation(
        code=code, name=meta["name"], event_date=ev, activation_date=act_date,
        url=PAGE_URL.format(code=code),
        note="" if ev else "event_date unknown -> activation date used",
    )
    if not ev:
        act.event_date = act_date
    aoi_names = {
        int(n): nm.strip()
        for n, nm in re.findall(r'aria-controls="aoi-\d+"[^>]*>\s*AOI(\d+)\s+([^<]*?)\s*<', page, re.S)
    }
    links = sorted(set(re.findall(r'(?:href|data-[a-z-]+)="([^"]+\.zip)"', page)))
    for href in links:
        url = href if href.startswith("http") else SITE + href
        fn = url.rsplit("/", 1)[-1]
        if mm := LEGACY_NEW.match(fn):
            num = int(mm["aoi"])
            act.units.append(Unit(num, aoi_names.get(num, f"AOI{num:02d}"), mm["kind"],
                                  int(mm["monit"] or 0), int(mm["ver"]), "", url, True))
        elif mm := LEGACY_OLD.match(fn):
            kind = KIND_MAP[mm["kind"]]
            if kind == "REF":
                continue  # pre-event reference map
            part = mm["part"]
            mon = re.search(r"MONIT(\d+)", part)
            det = re.search(r"DETAIL(\d+)", part)
            num = int(mm["aoi"])
            name = aoi_names.get(num) or mm["aoiname"].title()
            act.units.append(Unit(num, name, kind, int(mon[1]) if mon else 0, int(mm["ver"]),
                                  f"D{det[1]}" if det else "", url, True))
        elif code.startswith("EMSN") and "/download/" in url:
            # Risk & Recovery packages: one geospatial zip, AOI/product parsed from inner names
            act.units.append(Unit(1, aoi_names.get(1, "AOI01"), "DEL", 0, 1, "", url, True))
        else:
            log(f"   ? unrecognised package name {fn}")
    return act


# Event dates not stated in the activation text, set from well-documented event records.
EVENT_DATE_OVERRIDES = {
    "EMSR465": ("2020-09-18", "Medicane Ianos landfall / peak rainfall in Thessaly"),
    "EMSN184": ("2023-09-05", "Storm Daniel flood (same event as EMSR692); EMSN184 is a Dec-2023 recovery delineation"),
}


def build_activation(meta: dict, refresh: bool) -> Activation:
    code = meta["code"]
    d = RAW / code
    rm = cached_json(RM_API.format(code=code), d / "_rapidmapping.json", refresh)
    if rm and rm.get("results"):
        act = from_rapidmapping(meta, rm["results"][0])
    else:
        page = cached_text(PAGE_URL.format(code=code), d / "_page.html", refresh)
        act = from_legacy_page(meta, page or "")
    if code in EVENT_DATE_OVERRIDES:
        act.event_date, why = EVENT_DATE_OVERRIDES[code]
        act.note = f"event_date override: {why}"
    return act


# --------------------------------------------------------------------------- selection


PRODUCT_LABEL = {"DEL": "delineation", "GRA": "grading", "FEP": "first_estimate"}


def select_units(units: list[Unit]) -> list[tuple[str, list[Unit]]]:
    """Per AOI: the initial delineation (or grading / first estimate if no delineation)
    plus the latest monitoring of the same product type. Latest version per sheet."""
    best: dict[tuple, Unit] = {}
    for u in units:
        if u.key not in best or u.version > best[u.key].version:
            best[u.key] = u
    by_aoi: dict[int, list[Unit]] = defaultdict(list)
    for u in best.values():
        by_aoi[u.aoi_num].append(u)
    groups = []
    for num in sorted(by_aoi):
        us = by_aoi[num]
        kind = next(k for k in ("DEL", "GRA", "FEP") if any(u.kind == k for u in us) or k == "FEP")
        us = [u for u in us if u.kind == kind]
        if not us:
            continue
        base = [u for u in us if u.monit == 0]
        if base:
            groups.append((PRODUCT_LABEL[kind], base))
        mons = [u for u in us if u.monit > 0]
        if mons:
            last = max(u.monit for u in mons)
            groups.append(("monitoring", [u for u in mons if u.monit == last]))
    return groups


# --------------------------------------------------------------------------- extraction


def _norm_date(v) -> str | None:
    if v is None or v is pd.NaT or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (datetime, pd.Timestamp)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    if m := re.match(r"(\d{4})[-/](\d{2})[-/](\d{2})", s):
        return f"{m[1]}-{m[2]}-{m[3]}"
    if m := re.match(r"(\d{2})[-/.](\d{2})[-/.](\d{4})", s):
        return f"{m[3]}-{m[2]}-{m[1]}"
    if m := re.match(r"(\d{4})(\d{2})(\d{2})$", s):
        return f"{m[1]}-{m[2]}-{m[3]}"
    return None


def _read(path: str) -> gpd.GeoDataFrame:
    g = gpd.read_file(path)
    if g.crs is None:
        g = g.set_crs(4326)
    return g.to_crs(4326)


def _source_dates(zf: zipfile.ZipFile, zpath: Path, members: list[str], obs_member: str) -> dict:
    """Map source id -> acquisition date from the package's source table (dbf)."""
    stem = re.sub(r"observed_?event_?a?.*$", "", obs_member, flags=re.I)
    cands = [m for m in members if re.search(r"source", m, re.I) and m.lower().endswith(".dbf")]
    cands.sort(key=lambda m: (not m.startswith(stem), m))
    for m in cands:
        try:
            t = gpd.read_file(f"/vsizip/{zpath}/{m}")
        except Exception:  # noqa: BLE001
            continue
        cols = {c.lower(): c for c in t.columns}
        idc = next((cols[c] for c in ("src_id", "source_id", "id", "srcid") if c in cols), None)
        dc = next((cols[c] for c in ("src_date", "source_dat", "acq_date", "date", "srcdate") if c in cols), None)
        if dc is None:
            continue
        ph = cols.get("eventphase") or cols.get("event_phase")
        if ph is not None:
            post = t[t[ph].astype(str).str.contains("post", case=False)]
            if len(post):
                t = post
        out = {}
        for _, r in t.iterrows():
            dd = _norm_date(r[dc])
            if dd:
                out[str(r[idc]) if idc else len(out)] = dd
        if out:
            return out
    return {}


def _expand_nested(zpath: Path) -> list[Path]:
    """Return zpath plus any inner zips (extracted next to it, read-only use)."""
    out = [zpath]
    with zipfile.ZipFile(zpath) as zf:
        for m in zf.namelist():
            if m.lower().endswith(".zip"):
                dest = zpath.parent / "_inner" / zpath.stem / Path(m).name
                if not dest.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(m) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                out.extend(_expand_nested(dest))
    return out


# observed flood extent layers across CEMS data models:
#   2019+  *_observedEventA_*         2016-2019 *_observedEventA_* / *_observed_event_a*
#   2015   *_crisis_information_poly  Risk&Recovery (EMSN) *_FloodExtent_*
EXTENT_LAYER = re.compile(r"observed_?event|crisis_information_poly|floodextent", re.I)
SKIP_LAYER = re.compile(r"previous|intermediate", re.I)


def read_zip_unit(zpath: Path) -> list[gpd.GeoDataFrame]:
    frames = []
    for zp in _expand_nested(zpath):
        with zipfile.ZipFile(zp) as zf:
            members = zf.namelist()
            obs = [m for m in members if EXTENT_LAYER.search(m) and not SKIP_LAYER.search(m)
                   and m.lower().endswith(".shp")]
            if not obs:
                obs = [m for m in members if EXTENT_LAYER.search(m) and not SKIP_LAYER.search(m)
                       and m.lower().endswith((".json", ".geojson"))]
            for m in obs:
                try:
                    g = _read(f"/vsizip/{zp}/{m}")
                except Exception as e:  # noqa: BLE001
                    log(f"   ! cannot read {zp.name}!{m}: {e}")
                    continue
                g = g[g.geometry.notna() & g.geom_type.isin(["Polygon", "MultiPolygon"])]
                if g.empty:
                    continue
                src = _source_dates(zf, zp, members, m)
                g = g.copy()
                g["_member"] = m
                g["_srcmap"] = json.dumps(src)
                frames.append(g)
    return frames


NON_FLOOD = re.compile(r"landslide|fire|burn|earthquake|mass movement|water body|normal water", re.I)


def unit_frame(act: Activation, u: Unit) -> gpd.GeoDataFrame | None:
    d = RAW / act.code
    fn = u.url.split("?")[0].rsplit("/", 1)[-1]
    if not u.is_zip:
        p = download(u.url, d / fn)
        if p is None:
            return None
        frames = [_read(str(p))]
        frames[0]["_srcmap"] = "{}"
    else:
        p = download(u.url, d / (fn if fn.endswith(".zip") else fn + ".zip"))
        if p is None or not zipfile.is_zipfile(p):
            log(f"   ! not a zip: {u.url}")
            return None
        frames = read_zip_unit(p)
    if not frames:
        return None
    g = pd.concat(frames, ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs=4326)
    g = g[g.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    # drop clearly non-flood observed-event classes
    txtcols = [c for c in g.columns if c.lower() in ("notation", "obj_desc", "event_type", "obj_type", "remarks", "interpret", "subtype")]
    if txtcols:
        txt = g[txtcols].astype(str).agg(" ".join, axis=1)
        g = g[~txt.str.contains(NON_FLOOD)]
    # observation date per feature
    srccol = next((c for c in g.columns if c.lower() in ("dmg_src_id", "src_id", "source_id")), None)
    datecol = next((c for c in g.columns if c.lower() in ("src_date", "obs_date", "date", "source_dat")), None)
    fallback = u.obs_dates[-1] if u.obs_dates else None

    def obs(row):
        if datecol and (dd := _norm_date(row[datecol])):
            return dd
        sm = json.loads(row["_srcmap"]) if isinstance(row.get("_srcmap"), str) else {}
        if srccol and sm:
            k = row[srccol]
            for kk in (str(k), str(int(k)) if isinstance(k, float) and not pd.isna(k) else None):
                if kk and kk in sm:
                    return sm[kk]
        if sm:
            return max(sm.values())
        return fallback

    g["obs_date"] = g.apply(obs, axis=1) if len(g) else []
    known = g["obs_date"].dropna()
    if len(known) and g["obs_date"].isna().any():
        g["obs_date"] = g["obs_date"].fillna(known.mode().iloc[0])
    return g[["obs_date", "geometry"]]


# --------------------------------------------------------------------------- geometry


def clean_polys(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    if geom.geom_type == "GeometryCollection":
        parts = [p for p in geom.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        geom = unary_union(parts) if parts else None
    if geom is None or geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    return geom


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], 5), round(obj[1], 5)]
        return [round_coords(o) for o in obj]
    return obj


def drop_small(geom, min_area: float):
    """Remove polygon parts and interior holes smaller than min_area (m2)."""
    if min_area <= 0:
        return geom
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    out = []
    for p in polys:
        if p.area < min_area:
            continue
        holes = [h for h in p.interiors if shapely.Polygon(h).area >= min_area]
        out.append(shapely.Polygon(p.exterior, holes))
    if not out:
        return None
    return shapely.MultiPolygon(out) if len(out) > 1 else out[0]


def to_feature_collection(rows: list[dict], tol: float, min_area: float) -> tuple[str, list[dict]]:
    feats = []
    for r in rows:
        gm = drop_small(r["geom_m"], min_area)
        if gm is None:
            continue
        gm = clean_polys(gm.simplify(tol, preserve_topology=True))
        if gm is None:
            continue
        gm = drop_small(gm, max(min_area, tol * tol / 4))
        if gm is None:
            continue
        g4 = gpd.GeoSeries([gm], crs=METRIC_CRS).to_crs(4326).iloc[0]
        g4 = clean_polys(shapely.set_precision(g4, 1e-5))
        if g4 is None:
            continue
        feats.append({
            "type": "Feature",
            "properties": {k: r[k] for k in ("ems_code", "aoi", "product", "obs_date", "area_km2")},
            "geometry": {"type": g4.geom_type, "coordinates": round_coords(mapping(g4)["coordinates"])},
        })
    fc = {"type": "FeatureCollection", "features": feats}
    return json.dumps(fc, separators=(",", ":")), feats


def process(act: Activation) -> dict | None:
    groups = select_units(act.units)
    rows = []
    for product, units in groups:
        frames = []
        for u in units:
            f = unit_frame(act, u)
            if f is not None and len(f):
                f["aoi"] = f"AOI{u.aoi_num:02d} {u.aoi_name}".strip()
                frames.append(f)
        if not frames:
            continue
        g = pd.concat(frames, ignore_index=True)
        g = gpd.GeoDataFrame(g, geometry="geometry", crs=4326)
        g["geometry"] = shapely.make_valid(g.geometry.values)
        g = g.to_crs(METRIC_CRS)
        known = g["obs_date"].dropna()
        g["obs_date"] = g["obs_date"].fillna(known.mode().iloc[0] if len(known) else "")
        for (aoi, od), sub in g.groupby(["aoi", "obs_date"], sort=True):
            geom = clean_polys(unary_union([clean_polys(x) for x in sub.geometry if clean_polys(x) is not None]))
            if geom is None:
                continue
            rows.append({
                "ems_code": act.code, "aoi": aoi, "product": product,
                "obs_date": od or None, "area_km2": round(geom.area / 1e6, 3), "geom_m": geom,
            })
    if not rows:
        return None
    total = clean_polys(unary_union([r["geom_m"] for r in rows]))
    for tol, min_area in LADDER:
        text, feats = to_feature_collection(rows, tol, min_area)
        if len(text.encode()) < MAX_BYTES:
            break
        log(f"   {act.code}: {len(text) / 1e6:.2f} MB at tol={tol} m / min_area={min_area} m2, reducing")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{act.code}.geojson"
    out.write_text(text)
    tot4 = gpd.GeoSeries([total], crs=METRIC_CRS).to_crs(4326)
    cen = gpd.GeoSeries([total.centroid], crs=METRIC_CRS).to_crs(4326).iloc[0]
    minx, miny, maxx, maxy = tot4.total_bounds
    return {
        "code": act.code,
        "name": act.name,
        "event_date": act.event_date,
        "activation_date": act.activation_date,
        "bbox": [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)],
        "centroid": [round(cen.x, 5), round(cen.y, 5)],
        "url": act.url,
        "file": f"ems/{act.code}.geojson",
        "n_features": len(feats),
        "area_km2": round(total.area / 1e6, 2),
        "_tolerance_m": tol,
        "_min_area_m2": min_area,
        "_bytes": out.stat().st_size,
    }


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-fetch catalogue/metadata (zips stay cached)")
    ap.add_argument("--only", nargs="*", help="restrict to these activation codes")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)

    metas = discover(args.refresh)
    if args.only:
        metas = [m for m in metas if m["code"] in args.only]
    log(f"Greek flood/storm activations: {len(metas)}")
    index, skipped, report = [], [], []
    for meta in metas:
        code = meta["code"]
        log(f"== {code} {meta['name']}")
        try:
            act = build_activation(meta, args.refresh)
            entry = process(act) if act.units else None
        except Exception as e:  # noqa: BLE001
            log(f"   !! {code} failed: {e!r}")
            act, entry = None, None
            skipped.append({"code": code, "name": meta["name"], "reason": f"error: {e!r}"})
            continue
        if entry is None:
            reason = "no observed-event vector layer obtainable" if act.units else "no vector packages listed"
            skipped.append({"code": code, "name": act.name, "activation_date": act.activation_date, "reason": reason})
            stale = OUT_DIR / f"{code}.geojson"
            if stale.exists():
                stale.unlink()
            continue
        if act.note:
            entry["_note"] = act.note
        report.append(entry)
        index.append({k: v for k, v in entry.items() if not k.startswith("_")})

    if args.only:
        prev = WEB / "ems_index.json"
        if prev.exists():
            old = [e for e in json.loads(prev.read_text()) if e["code"] not in {i["code"] for i in index}
                   and e["code"] not in {s["code"] for s in skipped}]
            index = old + index
    index.sort(key=lambda e: e["event_date"] or e["activation_date"])
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "ems_index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    (RAW / "_skipped.json").write_text(json.dumps(skipped, indent=1, ensure_ascii=False))
    (RAW / "_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))

    print(f"\n{'code':9} {'event':10} {'n':>4} {'km2':>9} {'MB':>5} tol minA  name")
    for e in sorted(report, key=lambda e: e["event_date"]):
        print(f"{e['code']:9} {e['event_date']:10} {e['n_features']:>4} {e['area_km2']:>9.2f} "
              f"{e['_bytes'] / 1e6:>5.2f} {e['_tolerance_m']:>3} {e['_min_area_m2']:>6} {e['name']} {e.get('_note', '')}")
    print("\nskipped:")
    for s in skipped:
        print(f"  {s['code']} {s['name']}: {s['reason']}")


if __name__ == "__main__":
    main()
