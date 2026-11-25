"""Plain-language labels for the web app.

HANZE uses the official Eurostat NUTS3 names (Greek transliterations such as
"Kentrikos Tomeas Athinon"), and its event fields are database-style. This module
turns them into names and titles a general reader recognises.
"""
from __future__ import annotations

import re

# NUTS3 (2024) code -> commonly used English name
REGION_NAMES: dict[str, str] = {
    "EL301": "North Athens",
    "EL302": "West Athens",
    "EL303": "Central Athens",
    "EL304": "South Athens",
    "EL305": "East Attica",
    "EL306": "West Attica",
    "EL307": "Piraeus & Islands",
    "EL411": "Lesvos & Limnos",
    "EL412": "Samos & Ikaria",
    "EL413": "Chios",
    "EL421": "Dodecanese",
    "EL422": "Cyclades",
    "EL431": "Heraklion",
    "EL432": "Lasithi",
    "EL433": "Rethymno",
    "EL434": "Chania",
    "EL511": "Evros",
    "EL512": "Xanthi",
    "EL513": "Rhodope",
    "EL514": "Drama",
    "EL515": "Kavala & Thasos",
    "EL521": "Imathia",
    "EL522": "Thessaloniki",
    "EL523": "Kilkis",
    "EL524": "Pella",
    "EL525": "Pieria",
    "EL526": "Serres",
    "EL527": "Chalkidiki",
    "EL531": "Kozani & Grevena",
    "EL532": "Kastoria",
    "EL533": "Florina",
    "EL541": "Arta & Preveza",
    "EL542": "Thesprotia",
    "EL543": "Ioannina",
    "EL611": "Karditsa & Trikala",
    "EL612": "Larissa",
    "EL613": "Magnesia & Sporades",
    "EL621": "Zakynthos",
    "EL622": "Corfu",
    "EL623": "Kefalonia & Ithaca",
    "EL624": "Lefkada",
    "EL631": "Aetolia-Acarnania",
    "EL632": "Achaia",
    "EL633": "Ilia",
    "EL641": "Boeotia",
    "EL642": "Evia",
    "EL643": "Evrytania",
    "EL644": "Fthiotida",
    "EL645": "Fokida",
    "EL651": "Argolida & Arcadia",
    "EL652": "Corinthia",
    "EL653": "Laconia & Messinia",
}

# Greek names, so people can search in Greek ("Λάρισα", "Βόλος")
REGION_NAMES_EL: dict[str, str] = {
    "EL301": "Βόρειος Τομέας Αθηνών Αθήνα", "EL302": "Δυτικός Τομέας Αθηνών Αθήνα",
    "EL303": "Κεντρικός Τομέας Αθηνών Αθήνα", "EL304": "Νότιος Τομέας Αθηνών Αθήνα",
    "EL305": "Ανατολική Αττική", "EL306": "Δυτική Αττική Μάνδρα Ελευσίνα", "EL307": "Πειραιάς Νήσοι",
    "EL411": "Λέσβος Λήμνος Μυτιλήνη", "EL412": "Ικαρία Σάμος", "EL413": "Χίος",
    "EL421": "Δωδεκάνησα Κάλυμνος Κάρπαθος Κάσος Κως Ρόδος",
    "EL422": "Κυκλάδες Άνδρος Θήρα Σαντορίνη Κέα Μήλος Μύκονος Νάξος Πάρος Σύρος Τήνος",
    "EL431": "Ηράκλειο", "EL432": "Λασίθι", "EL433": "Ρέθυμνο", "EL434": "Χανιά",
    "EL511": "Έβρος Αλεξανδρούπολη", "EL512": "Ξάνθη", "EL513": "Ροδόπη Κομοτηνή", "EL514": "Δράμα",
    "EL515": "Θάσος Καβάλα", "EL521": "Ημαθία Βέροια", "EL522": "Θεσσαλονίκη", "EL523": "Κιλκίς",
    "EL524": "Πέλλα Έδεσσα", "EL525": "Πιερία Κατερίνη", "EL526": "Σέρρες", "EL527": "Χαλκιδική",
    "EL531": "Γρεβενά Κοζάνη", "EL532": "Καστοριά", "EL533": "Φλώρινα", "EL541": "Άρτα Πρέβεζα",
    "EL542": "Θεσπρωτία Ηγουμενίτσα", "EL543": "Ιωάννινα", "EL611": "Καρδίτσα Τρίκαλα",
    "EL612": "Λάρισα", "EL613": "Μαγνησία Σποράδες Βόλος", "EL621": "Ζάκυνθος", "EL622": "Κέρκυρα",
    "EL623": "Ιθάκη Κεφαλονιά Κεφαλληνία", "EL624": "Λευκάδα", "EL631": "Αιτωλοακαρνανία Αγρίνιο Μεσολόγγι",
    "EL632": "Αχαΐα Πάτρα", "EL633": "Ηλεία Πύργος", "EL641": "Βοιωτία Λιβαδειά Θήβα", "EL642": "Εύβοια Χαλκίδα",
    "EL643": "Ευρυτανία Καρπενήσι", "EL644": "Φθιώτιδα Λαμία", "EL645": "Φωκίδα Άμφισσα",
    "EL651": "Αργολίδα Αρκαδία Ναύπλιο Τρίπολη", "EL652": "Κορινθία Κόρινθος", "EL653": "Λακωνία Μεσσηνία Σπάρτη Καλαμάτα",
}

ATHENS = {"EL301", "EL302", "EL303", "EL304"}

TYPE_LABEL = {
    "flash": "Flash flood",
    "river": "River flood",
    "coastal": "Coastal flood",
    "compound": "River & coastal flood",
    "pluvial": "Urban flood",
}

# keyword in any case, but the storm's name must be capitalised ("storm surge" is not a storm name)
STORM_RE = re.compile(r"\b((?i:storm|medicane|cyclone|hurricane))\s+([A-Z][a-z]+)")
NOT_NAMES = {"Surge", "Damage", "Water", "Season"}
# spelling variants seen in sources -> name used by the Hellenic National Meteorological Service
STORM_ALIASES = {"Janos": "Ianos", "Zorba": "Zorbas"}
# Mediterranean cyclones with tropical characteristics are known in Greece as "medicanes"
MEDICANES = {"Ianos", "Zorbas", "Daniel"}


def region_name(code: str, fallback: str | None = None) -> str:
    return REGION_NAMES.get(code, fallback or code)


def place_label(codes: list[str], max_names: int = 2) -> str:
    """'Athens', 'Karditsa & Trikala and Larissa', 'Evros, Serres and 2 other areas'."""
    codes = list(dict.fromkeys(codes))
    names: list[str] = []
    if len(ATHENS.intersection(codes)) >= 2:
        names.append("Athens")
        codes = [c for c in codes if c not in ATHENS]
    names += [region_name(c) for c in codes]
    if not names:
        return "Greece"
    if len(names) <= max_names:
        return " and ".join(names) if len(names) == 2 else names[0]
    rest = len(names) - max_names
    return f"{', '.join(names[:max_names])} and {rest} other area{'s' if rest > 1 else ''}"


def storm_name(*texts: str | None) -> str | None:
    for t in texts:
        for m in STORM_RE.finditer(t or ""):
            name = m.group(2)
            if name in NOT_NAMES:
                continue
            name = STORM_ALIASES.get(name, name)
            if name in MEDICANES and name != "Daniel":
                return f"Medicane {name}"
            return f"Storm {name}"
    return None


# NUTS2 regions ("periphery") — the scale people use to name big storms ("Storm Daniel hit Thessaly")
NUTS2_NAMES = {
    "EL30": "Attica", "EL41": "North Aegean", "EL42": "South Aegean", "EL43": "Crete",
    "EL51": "Eastern Macedonia & Thrace", "EL52": "Central Macedonia", "EL53": "Western Macedonia",
    "EL54": "Epirus", "EL61": "Thessaly", "EL62": "Ionian Islands", "EL63": "Western Greece",
    "EL64": "Central Greece", "EL65": "Peloponnese",
}

# floods the public knows by a name that the database's area coding doesn't convey
# (HANZE codes Mandra 2017 to West Attica + Dodecanese because the same storm also hit the islands)
KNOWN_NAMES = {
    2135: "Mandra flash flood, West Attica",
}


def main_region(codes: list[str]) -> str:
    """Region (NUTS2) with the most affected areas; ties go to the first listed."""
    counts: dict[str, int] = {}
    for c in codes:
        counts[c[:4]] = counts.get(c[:4], 0) + 1
    best = max(counts, key=lambda k: (counts[k], -list(counts).index(k))) if counts else ""
    return NUTS2_NAMES.get(best, "Greece")


def event_title(type_: str | None, codes: list[str], storm: str | None, hanze_id: int | None = None) -> str:
    if hanze_id in KNOWN_NAMES:
        return KNOWN_NAMES[hanze_id]
    if storm:
        return f"{storm}, {main_region(codes)}"
    return f"{TYPE_LABEL.get(type_ or '', 'Flood')} in {place_label(codes)}"


def clean_note(text: str | None) -> str | None:
    """HANZE notes are terse fragments ('also landslides; insured loss'). Sentence-case them."""
    if not text:
        return None
    for alias, name in STORM_ALIASES.items():
        text = re.sub(rf"\b{alias}\b", name, text)
    # "(cyclone Ianos)" / "(Storm Elias)" repeat the title
    text = re.sub(r"\s*\((?i:storm|medicane|cyclone)\s+[A-Z][a-z]+\)", "", text)
    # region codes like "(EL421)" -> "(Dodecanese)"
    text = re.sub(r"\b(EL\d{3})\b", lambda m: REGION_NAMES.get(m.group(1), m.group(1)), text)
    text = re.sub(r"\binsured loss(es)?\b", "insured losses were reported", text, flags=re.IGNORECASE)
    parts = [p.strip() for p in re.split(r";\s*", text) if p.strip()]
    # a note that only repeats the storm name adds nothing (the title already has it)
    parts = [p for p in parts if not STORM_RE.fullmatch(p.rstrip("."))]
    parts = [p[0].upper() + p[1:] for p in parts]
    out = ". ".join(p.rstrip(".") for p in parts)
    return out + "." if out else None
