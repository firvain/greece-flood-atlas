"""Build the local flood-event layer from the Greek Ministry of Environment & Energy (YPEN)
Floods Directive GeoServer.

Output:
  web/data/local_floods.geojson - one Point per recorded local flood event (community level)

Source: WFS https://gis.floods.ypeka.gr/geoserver/floods_rev1/wfs
  - floods_rev1:hyd_poi_all_floods_v1        ("Πλημμυρικά Συμβάντα", all events)          -> used
  - floods_rev1:hyd_poi_historical_floods_v1 (civil_prot=YES subset of the above)          -> subset check only
  - floods_rev1:adm_poi_oikismoi             (ELSTAT settlements, attributes only)        -> place-name lookup

Raw downloads are cached in data/raw/ypen/ and reused when present.

Run from repo root:
  uv run --project pipeline python pipeline/build_ypen.py
"""

from __future__ import annotations

import bisect
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "ypen"
OUT = ROOT / "web" / "data" / "local_floods.geojson"

WFS = "https://gis.floods.ypeka.gr/geoserver/floods_rev1/wfs"
LAYERS = {
    "events": "floods_rev1:hyd_poi_all_floods_v1",
    "historical": "floods_rev1:hyd_poi_historical_floods_v1",
}
SETTLEMENTS_LAYER = "floods_rev1:adm_poi_oikismoi"

# River Basin Districts (Υδατικά Διαμερίσματα), checked against the WFS layer
# floods_rev1:hyd_pol_ydatika_diamerismata (eurbdcode / rbdname / rbdnamenl).
BASINS = {
    "EL01": "Western Peloponnese",
    "EL02": "Northern Peloponnese",
    "EL03": "Eastern Peloponnese",
    "EL04": "Western Sterea Ellada",
    "EL05": "Epirus",
    "EL06": "Attica",
    "EL07": "Eastern Sterea Ellada",
    "EL08": "Thessaly",
    "EL09": "Western Macedonia",
    "EL10": "Central Macedonia",
    "EL11": "Eastern Macedonia",
    "EL12": "Thrace",
    "EL13": "Crete",
    "EL14": "Aegean Islands",
}

IMPACT_INFRA = "Damage to roads and infrastructure"
IMPACT_PROPERTY = "Damage to homes and property"
IMPACT_FARMLAND = "Farmland affected"
IMPACT_PEOPLE = "People harmed"
IMPACT_ORDER = [IMPACT_INFRA, IMPACT_PROPERTY, IMPACT_FARMLAND, IMPACT_PEOPLE]

GREECE_BBOX = (19.0, 34.5, 30.0, 42.0)


# --------------------------------------------------------------------------- download
def wfs_get(layer: str, dest: Path, extra: dict | None = None) -> dict:
    if dest.exists() and dest.stat().st_size > 0:
        return json.loads(dest.read_text(encoding="utf-8"))
    print(f"  downloading {layer}")
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": layer,
        "outputFormat": "application/json",
        "srsName": "EPSG:4326",
        **(extra or {}),
    }
    r = requests.get(WFS, params=params, timeout=300)
    r.raise_for_status()
    data = r.json()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


# --------------------------------------------------------------------------- dates
RE_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})Z?$")
RE_SLASH = re.compile(r"^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$")
RE_CODE = re.compile(r"^(\d+)\s*-\s*(\d{1,2})/(\d{1,2})/(\d{4})$")  # "<a/a>-DD/MM/YYYY"


def _mk(y: int, m: int, d: int) -> date | None:
    try:
        dt = date(y, m, d)
    except ValueError:
        return None
    return dt if 1800 <= y <= date.today().year else None


def parse_any(s) -> tuple[date | None, str]:
    """Parse one raw date-ish string. Returns (date, kind) with kind in iso/slash/code/none."""
    if s is None:
        return None, "none"
    s = str(s).strip()
    if m := RE_ISO.match(s):
        return _mk(int(m[1]), int(m[2]), int(m[3])), "iso"
    if m := RE_CODE.match(s):
        return _mk(int(m[4]), int(m[3]), int(m[2])), "code"
    if m := RE_SLASH.match(s):
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        # Source convention is D/M/Y (verified against event_code); fall back to M/D/Y
        # only when D/M/Y is impossible.
        return (_mk(y, b, a) or _mk(y, a, b)), "slash"
    return None, "none"


def parse_event_date(p: dict, stats: Counter) -> date | None:
    raw_date, raw_code = p.get("date"), p.get("event_code")
    d1, k1 = parse_any(raw_date)
    d2, k2 = parse_any(raw_code)
    if k1 == "code" and k2 in ("iso", "slash"):
        stats["swapped"] += 1  # date and event_code columns swapped
        d1, k1, d2, k2 = d2, k2, d1, k1
    if d1 and d2 and d1 != d2:
        stats["date_vs_code_disagree"] += 1
    if d1:
        return d1
    if d2:
        stats["date_from_code_only"] += 1
        return d2
    stats["unparseable"] += 1
    return None


# --------------------------------------------------------------------------- names
def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def fold(s: str) -> str:
    return strip_accents(s).upper()


def fix_final_sigma(s: str) -> str:
    return re.sub(r"σ(?![\wΑ-Ωα-ωά-ώ])", "ς", s)


# Administrative prefixes, compared accent- and case-insensitively (source mixes
# "Τοπική Κοινότητα ..." with "ΔΗΜΟΤΙΚΗ ΕΝΟΤΗΤΑ ...").
_PREFIXES = [
    fold(p).split()
    for p in (
        "Δημοτική Κοινότητα", "Τοπική Κοινότητα", "Ψευδοδημοτική Κοινότητα",
        "Δημοτική Ενότητα", "Περιφερειακή Ενότητα", "Δήμος", "Κοινότητα",
    )
]


def strip_prefix(s: str) -> str:
    ws = s.split()
    fw = [fold(w) for w in ws]
    for pre in _PREFIXES:
        if len(fw) > len(pre) and fw[: len(pre)] == pre:
            return " ".join(ws[len(pre):])
    return s.strip()


# ELSTAT 2011 settlement names are in katharevousa; nudge the commonest endings to the
# everyday (demotic) form so names read and search naturally.
_MODERN_EXCEPTIONS = {"Αθήναι": "Αθήνα", "Πάτραι": "Πάτρα", "Θήβαι": "Θήβα", "Σπέτσαι": "Σπέτσες"}


def modernise(name: str) -> str:
    out = []
    for w in name.split(" "):
        if w in _MODERN_EXCEPTIONS:
            w = _MODERN_EXCEPTIONS[w]
        elif len(w) > 3 and w.endswith(("πολις", "πολίς")):
            w = w[:-2] + "η"
        elif len(w) > 3 and w.endswith("ον"):
            w = w[:-1]
        elif len(w) > 3 and w.endswith("αι"):
            w = w[:-2] + "ες"
        elif len(w) > 3 and w.endswith("αί"):
            w = w[:-2] + "ές"
        out.append(w)
    return " ".join(out)
ARTICLE_RE = re.compile(r",\s*(?:ο|η|το|οι|τα|αι|ai)\b\s*", re.IGNORECASE)


def is_all_caps(s: str) -> bool:
    letters = [c for c in s if c.isalpha()]
    return bool(letters) and all(c.isupper() for c in letters)


def word_prefix_ok(nom: str, gen: str) -> bool:
    """Does nominative word `nom` plausibly inflect to genitive word `gen`? (same stem)"""
    a, b = fold(nom), fold(gen)
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    short = min(len(a), len(b))
    need = max(2, short - 2 if short <= 6 else short - 3)
    return n >= need


def words(s: str) -> list[str]:
    return [w for w in re.split(r"[\s\-–]+", s) if w]


def match_nominative(nom: str, gen: str) -> str | None:
    """If settlement name `nom` matches genitive community name `gen`, return the nominative
    form (keeping any trailing genitive qualifier, e.g. 'Νεοχώριον Γορτυνίας')."""
    nw, gw = words(nom), words(gen)
    if not nw or len(nw) > len(gw):
        return None
    if not all(word_prefix_ok(a, b) for a, b in zip(nw, gw)):
        return None
    if len(nw) < len(gw):
        # qualifier words: only allow when the extra words follow a full match
        return nom + " " + " ".join(gw[len(nw):])
    return nom


def drop_island_note(s: str) -> str:
    """'Ψέριμος (νήσις)' -> 'Ψέριμος' (accent/case-insensitive)."""
    s = re.sub(r"\(([^)]*)\)", lambda m: "" if fold(m[1]).strip() in ("ΝΗΣΙΣ", "ΝΗΣΟΣ") else m[0], s)
    return re.sub(r"\s+", " ", s).strip()


class PlaceNamer:
    def __init__(self, settlements: list[dict]):
        self.by_code: dict[str, str] = {}
        self.codes_sorted: list[str] = []
        accent_votes: dict[str, Counter] = defaultdict(Counter)
        for p in settlements:
            code = str(p.get("kalcode") or "")
            name = self._clean_settlement(p.get("oikismos") or "")
            if code and name:
                self.by_code[code] = name
            for txt in (name, strip_prefix((p.get("top_koin") or "").replace("’", "Ά"))):
                for w in words(txt.replace("(", " ").replace(")", " ")):
                    if not is_all_caps(w) and w != strip_accents(w):
                        accent_votes[fold(w)][w] += 1
        self.codes_sorted = sorted(self.by_code)
        self.accent = {k: c.most_common(1)[0][0] for k, c in accent_votes.items()}
        self.stats: Counter = Counter()

    @staticmethod
    def _clean_settlement(s: str) -> str:
        # The WFS serves 'Ά' as '’' (cp1253 0xA2 decoded as ISO-8859-7).
        s = s.replace("’", "Ά").strip()
        s = ARTICLE_RE.sub(" ", s)
        return drop_island_note(s)

    def titlecase(self, s: str) -> str:
        """Greek-aware title case of an ALL-CAPS string, restoring accents from the
        ELSTAT settlement vocabulary where a word is known."""
        out = []
        for tok in re.split(r"(\s+|-|–|\(|\))", s):
            if not tok or not any(c.isalpha() for c in tok):
                out.append(tok)
                continue
            acc = self.accent.get(fold(tok))
            if acc:
                out.append(acc[0].upper() + acc[1:])
            else:
                low = fix_final_sigma(tok.lower())
                out.append(low[0].upper() + low[1:])
        return "".join(out)

    def candidates(self, code: str) -> list[str]:
        """Settlement codes under an administrative code (community/unit/municipality)."""
        if not code.isdigit():
            return []
        stem = code.rstrip("0") if len(code) < 10 else code
        if len(stem) % 2:
            stem += "0"
        if not stem:
            return []
        i = bisect.bisect_left(self.codes_sorted, stem)
        res = []
        while i < len(self.codes_sorted) and self.codes_sorted[i].startswith(stem):
            res.append(self.codes_sorted[i])
            i += 1
        return res

    def place(self, raw_name, raw_code, fallback_name=None) -> str | None:
        name = re.sub(r"\s+", " ", str(raw_name or "")).strip()
        code = str(raw_code or "").strip()
        if not any(c.isalpha() for c in name) and fallback_name:
            self.stats["name_from_same_code"] += 1
            name = fallback_name
        if not any(c.isalpha() for c in name):
            self.stats["empty"] += 1
            return None
        name = strip_prefix(name)
        caps = is_all_caps(name)
        # settlement-style "ΧΕΛΙΔΟΝΙΟΝ,ΤΟ"
        has_article = bool(ARTICLE_RE.search(name))
        name = drop_island_note(ARTICLE_RE.sub(" ", name))
        name = re.sub(r"\s*-\s*", " - ", name)
        compound = " - " in name  # merged units, e.g. "Ερεσού - Αντίσσης": keep as given
        if caps:
            name = self.titlecase(name)

        # 1) exact settlement code (10 digits) -> accented ELSTAT name
        if len(code) == 10 and code in self.by_code:
            cand = self.by_code[code]
            if match_nominative(cand, name) == cand or fold(cand) == fold(name):
                self.stats["settlement_code"] += 1
                return modernise(cand)
        # 2) genitive community / unit name -> nominative of its seat settlement
        if not has_article and not compound:
            cands = self.candidates(code)
            # seat settlement first: <unit>0101 / <community>01
            seat_first = sorted(cands, key=lambda c: (not c.endswith("0101"), not c.endswith("01"), c))
            for c in seat_first:
                nom = match_nominative(self.by_code[c], name)
                if nom:
                    self.stats["nominative_from_settlement"] += 1
                    base = self.by_code[c]
                    return modernise(base) + nom[len(base):]
        # 3) fall back to the cleaned source text
        self.stats["source_text_caps" if caps else "source_text"] += 1
        return name


# --------------------------------------------------------------------------- transliteration
# ELOT 743 (simplified) Greek -> Latin.
_VOICED = set("βγδζλμνραεηιυοωάέήίύόώϊϋ")  # αυ/ευ/ηυ -> v before vowels & voiced consonants
_SINGLE = {
    "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th",
    "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p",
    "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps",
    "ω": "o",
}
_DIGRAPH = {"ου": "ou", "αι": "ai", "ει": "ei", "οι": "oi", "υι": "yi", "μπ": "mp",
            "ντ": "nt", "γγ": "ng", "γκ": "gk", "γξ": "nx", "γχ": "nch", "τσ": "ts", "τζ": "tz"}


def translit(s: str | None) -> str | None:
    if s is None:
        return None
    # Normalise: keep diaeresis (breaks diphthongs), drop tonos.
    chars: list[tuple[str, bool, bool]] = []  # (base lowercase letter, was_upper, has_diaeresis)
    for ch in unicodedata.normalize("NFD", s):
        if unicodedata.category(ch) == "Mn":
            if ch == "̈" and chars:
                b, u, _ = chars[-1]
                chars[-1] = (b, u, True)
            continue
        chars.append((ch.lower(), ch.isupper(), False))

    out: list[str] = []
    i, n = 0, len(chars)
    while i < n:
        c, up, _ = chars[i]
        nxt = chars[i + 1] if i + 1 < n else None
        tr, step = None, 1
        if nxt is not None and not nxt[2]:
            pair = c + nxt[0]
            if c in "αεη" and nxt[0] == "υ":
                after = chars[i + 2][0] if i + 2 < n else ""
                tr = {"α": "a", "ε": "e", "η": "i"}[c] + ("v" if after in _VOICED else "f")
                step = 2
            elif pair in _DIGRAPH:
                tr, step = _DIGRAPH[pair], 2
                # word-initial μπ/ντ -> b/d (ELOT 743)
                prev = chars[i - 1][0] if i > 0 else " "
                if pair in ("μπ", "ντ") and not prev.isalpha():
                    tr = "b" if pair == "μπ" else "d"
        if tr is None:
            tr = _SINGLE.get(c, c)
        if up:
            # Capitalise like the source: only the first letter if the next source letter
            # is lowercase (Θεσσαλονίκη -> Thessaloniki), otherwise whole token (ΘΕ -> THE).
            follow = chars[i + step] if i + step < n else None
            whole = follow is not None and follow[1] and follow[0].isalpha()
            tr = tr.upper() if whole else tr[0].upper() + tr[1:]
        out.append(tr)
        i += step
    return "".join(out)


# --------------------------------------------------------------------------- build
def impacts_of(p: dict) -> list[str]:
    got = set()
    econ = str(p.get("economic_i") or "")
    if "B42" in econ:
        got.add(IMPACT_INFRA)
    if "B41" in econ:
        got.add(IMPACT_PROPERTY)
    if "B43" in str(p.get("rural_impa") or ""):
        got.add(IMPACT_FARMLAND)
    if "B11" in str(p.get("fatalities") or ""):
        got.add(IMPACT_PEOPLE)
    return [x for x in IMPACT_ORDER if x in got]


def civil_prot(v) -> bool | None:
    # Source mixes Latin "NO" with Greek-lookalike "ΝΟ"; map lookalikes to Latin first.
    s = fold(str(v or "")).strip().translate(str.maketrans("ΑΕΙΝΟΥΧΣ", "AEINOYXS"))
    if s in ("YES", "Y", "NAI"):
        return True
    if s in ("NO", "N", "OXI"):
        return False
    return None


def coord_key(f: dict) -> tuple[float, float]:
    x, y = f["geometry"]["coordinates"][:2]
    return round(x, 5), round(y, 5)


def main() -> int:
    print("YPEN Floods Directive flood events")
    events = wfs_get(LAYERS["events"], RAW / "events.json")["features"]
    historical = wfs_get(LAYERS["historical"], RAW / "historical.json")["features"]
    settlements = wfs_get(
        SETTLEMENTS_LAYER, RAW / "oikismoi.json", {"propertyName": "kalcode,oikismos,top_koin"}
    )["features"]
    print(f"  events: {len(events)}  historical: {len(historical)}  settlements: {len(settlements)}")

    # ---- subset check: historical vs events (fids are independent, compare content)
    def content_key(f):
        p = f["properties"]
        return (coord_key(f), p.get("date"), p.get("event_code"), str(p.get("code_commu")))

    ev_keys = Counter(content_key(f) for f in events if f.get("geometry"))
    hist_in = sum(1 for f in historical if f.get("geometry") and content_key(f) in ev_keys)
    hist_cp = Counter(str(f["properties"].get("civil_prot")) for f in historical)
    print(f"  historical rows found in events (coords+date+code+community): {hist_in}/{len(historical)}"
          f"; historical civil_prot values: {dict(hist_cp)}")
    if hist_in != len(historical):
        print("  WARNING: historical is not a strict subset of events; using events only anyway")

    namer = PlaceNamer([f["properties"] for f in settlements])
    # Some rows carry a code but a junk name ("0"); borrow the name another row gives that code.
    name_votes: dict[str, Counter] = defaultdict(Counter)
    for f in events:
        nm = str(f["properties"].get("name_commu") or "").strip()
        if any(c.isalpha() for c in nm):
            name_votes[str(f["properties"].get("code_commu"))][nm] += 1
    name_by_code = {k: c.most_common(1)[0][0] for k, c in name_votes.items()}
    dstats: Counter = Counter()
    feats = []
    skipped = Counter()
    for f in events:
        g = f.get("geometry")
        if not g or g.get("type") != "Point":
            skipped["no_point_geometry"] += 1
            continue
        x, y = g["coordinates"][:2]
        if not (GREECE_BBOX[0] <= x <= GREECE_BBOX[2] and GREECE_BBOX[1] <= y <= GREECE_BBOX[3]):
            skipped["outside_greece"] += 1
            continue
        p = f["properties"]
        d = parse_event_date(p, dstats)
        place = namer.place(p.get("name_commu"), p.get("code_commu"),
                            name_by_code.get(str(p.get("code_commu"))))
        harmed = "B11" in str(p.get("fatalities") or "")
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(x, 5), round(y, 5)]},
            "properties": {
                "id": f"YPEN-{p['fid']}",
                "date": d.isoformat() if d else None,
                "year": d.year if d else None,
                "place": place,
                "place_en": translit(place),
                "basin": BASINS.get(str(p.get("rbd") or "").strip().upper()),
                "impacts": impacts_of(p),
                "civil_protection": civil_prot(p.get("civil_prot")),
                "people_harmed": harmed,
            },
        })

    feats.sort(key=lambda f: (f["properties"]["date"] or "9999", f["properties"]["id"]))
    ids = Counter(f["properties"]["id"] for f in feats)
    assert max(ids.values()) == 1, "duplicate ids"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fc = {
        "type": "FeatureCollection",
        "name": "local_floods",
        "source": "Greek Ministry of Environment & Energy, Floods Directive (floods_rev1:hyd_poi_all_floods_v1)",
        "features": feats,
    }
    OUT.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- report
    props = [f["properties"] for f in feats]
    years = Counter(p["year"] for p in props if p["year"])
    same_dc = Counter((p["date"], p["place"]) for p in props if p["date"] and p["place"])
    multi = {k: v for k, v in same_dc.items() if v > 1}
    same_pt = Counter((f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1], f["properties"]["date"]) for f in feats)
    print(f"\nwrote {OUT.relative_to(ROOT)}: {len(feats)} features, {OUT.stat().st_size / 1024:.0f} KB")
    if skipped:
        print(f"  skipped: {dict(skipped)}")
    print(f"  dates: swapped={dstats['swapped']} unparseable={dstats['unparseable']} "
          f"date_vs_code_disagree={dstats['date_vs_code_disagree']} from_code_only={dstats['date_from_code_only']}")
    if years:
        print(f"  years {min(years)}-{max(years)}: " + ", ".join(f"{y}:{years[y]}" for y in sorted(years)))
    print(f"  place resolution: {dict(namer.stats)}")
    print(f"  date+place groups with >1 record: {len(multi)} groups, {sum(multi.values())} records"
          f" (max {max(multi.values()) if multi else 0}); identical coord+date: "
          f"{sum(v for v in same_pt.values() if v > 1)} records")
    print(f"  basins: {dict(sorted(Counter(p['basin'] for p in props).items(), key=lambda kv: str(kv[0])))}")
    print(f"  civil_protection: {dict(Counter(p['civil_protection'] for p in props))}  "
          f"people_harmed: {sum(p['people_harmed'] for p in props)}")
    print(f"  impacts: {dict(Counter(i for p in props for i in p['impacts']))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
