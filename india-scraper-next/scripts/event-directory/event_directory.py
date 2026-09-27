#!/usr/bin/env python3
"""Brahmini event directory: event venues and vendors, country by country, starting with India.

Stages (run all with `all`, or one at a time):
  overture  Overture Maps Places (open data, CDLA-Permissive-2.0) for one country, straight
            from Overture's public S3 bucket with DuckDB. Also fetches the country's district
            (county) and state (region) boundaries from Overture Divisions.
  osm       OpenStreetMap (ODbL) through the Overpass API, one state at a time.
  google    Imports what Brahmini's own Google Maps collectors already found (India): the
            event-planner survey and the gap-filling runs (scripts/event-directory/google-gaps.cjs).
  build     Classifies everything with taxonomy.json, assigns districts, merges duplicates across
            sources and writes data/event-directory/: directory.db (SQLite), a CSV, a summary and
            gaps-<CC>.json (district x category combinations with too few places).

Nothing is inferred: every place keeps its sources, source ids and licence. Categories come
from the sources' own categories or tags, or from the name (marked match_basis='name').
Counts are what the sources list, not a census.

Needs Python 3.9+ and `duckdb` (pip). The DuckDB httpfs/spatial extensions are downloaded by
DuckDB on first use; without spatial, districts are assigned from boundary boxes instead.
"""
import argparse, csv, datetime as dt, gzip, hashlib, json, math, os, re, sqlite3, sys, time
import urllib.error, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = Path(os.environ.get("EVENT_DIRECTORY_APP", HERE.parent.parent))   # india-scraper-next
OUT = Path(os.environ.get("EVENT_DIRECTORY_DIR", APP / "data" / "event-directory"))
RAW = OUT / "raw"
UA = "BrahminiEventDirectory/1.0 (local research; contact: repository owner)"
BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
OVERPASS = [u for u in os.environ.get("OVERPASS_URLS", "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",") if u]
FALLBACK_BBOX = {"IN": (68.0, 6.5, 97.5, 37.2)}          # xmin, ymin, xmax, ymax
LICENCE = {"overture": "Overture Maps Places, CDLA-Permissive-2.0 (and ODbL where sourced from OSM)",
           "osm": "OpenStreetMap contributors, ODbL-1.0",
           "google": "Google Maps public search results (collected locally; subject to Google's terms)"}
SOURCE_RANK = {"google": 0, "overture": 1, "osm": 2}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_taxonomy():
    t = json.loads((HERE / "taxonomy.json").read_text(encoding="utf-8"))
    for c in t["categories"]:
        c["cat_re"] = re.compile(c["cat"], re.I)
        c["name_re"] = re.compile(c["name"], re.I)
    t["exclude_re"] = re.compile(t["exclude"], re.I)
    return t


def words(text):
    """Category or tag text as plain words: 'venue_and_event_space' -> 'venue and event space'."""
    return re.sub(r"[_:/;|,]+", " ", str(text or "")).lower()


def classify(tax, cats, name):
    """Returns (category ids, match basis) for one place, or ([], None) when it is not event-related."""
    c, n = words(cats), str(name or "")
    by_cat = [x["id"] for x in tax["categories"] if c and x["cat_re"].search(c)]
    if by_cat:
        # Overture files many venues and vendors under one catch-all ("party and event planning").
        # When that is all the category says, a specific name ("… Mangal Karyalay", "… Caterers") wins.
        if set(by_cat) <= {"vendor.event_planner"}:
            by_name = [x["id"] for x in tax["categories"] if x["id"] != "vendor.event_planner" and x["name_re"].search(n)]
            if by_name:
                return by_name + by_cat, "category"
        return by_cat, "category"
    if c and tax["exclude_re"].search(c):
        return [], None
    by_name = [x["id"] for x in tax["categories"] if x["name_re"].search(n)]
    return (by_name, "name") if by_name else ([], None)


def prefilter_regex(tax):
    """One broad regex for SQL/Overpass pre-filtering; precise matching happens in classify()."""
    parts = []
    for x in tax["categories"]:
        for p in (x["cat"], x["name"]):
            parts.append("(" + p.replace("\\b", "") + ")")
    return "|".join(parts)


# ------------------------------------------------------------------ Overture Maps

def latest_release():
    if os.environ.get("OVERTURE_RELEASE"):
        return os.environ["OVERTURE_RELEASE"]
    url = BUCKET + "/?list-type=2&prefix=release/&delimiter=/"
    xml = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read().decode()
    releases = sorted(re.findall(r"<Prefix>release/([^/<]+)/</Prefix>", xml))
    if not releases:
        raise SystemExit("Could not list Overture releases from " + url)
    return releases[-1]


def duck(extensions=("httpfs",)):
    import duckdb
    con = duckdb.connect()
    loaded = set()
    for e in extensions:
        try:
            con.execute(f"INSTALL {e}; LOAD {e};")
            loaded.add(e)
        except Exception as err:  # noqa: BLE001
            log(f"DuckDB extension {e} not available: {str(err)[:120]}")
    if "httpfs" in loaded:
        con.execute("SET s3_region='us-west-2';")
    return con, loaded


def first_working(con, source, candidates):
    """The first SQL expression that DuckDB can evaluate on this dataset (schemas change between releases)."""
    for expr in candidates:
        try:
            con.execute(f"SELECT {expr} FROM {source} LIMIT 0")
            return expr
        except Exception:  # noqa: BLE001
            continue
    return None


def working_list(con, source, candidates):
    return [e for e in candidates if first_working(con, source, [e])]


def fetch_overture(cc, tax, source_root=None):
    RAW.mkdir(parents=True, exist_ok=True)
    con, loaded = duck(("httpfs", "spatial"))
    if source_root:                                     # tests / offline copies
        places = f"read_parquet('{source_root}/theme=places/type=place/*.parquet', hive_partitioning=1, union_by_name=1)"
        divisions = f"read_parquet('{source_root}/theme=divisions/type=division_area/*.parquet', hive_partitioning=1, union_by_name=1)"
        release = "local"
    else:
        release = latest_release()
        base = f"s3://overturemaps-us-west-2/release/{release}"
        places = f"read_parquet('{base}/theme=places/type=place/*', hive_partitioning=1, union_by_name=1)"
        divisions = f"read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning=1, union_by_name=1)"
    log(f"Overture release {release}")

    # Country box, from the country boundary (falls back to a built-in box).
    bbox = None
    try:
        row = con.execute(f"SELECT min(bbox.xmin), min(bbox.ymin), max(bbox.xmax), max(bbox.ymax) FROM {divisions} WHERE subtype='country' AND country=?", [cc]).fetchone()
        if row and row[0] is not None:
            bbox = row
    except Exception as err:  # noqa: BLE001
        log("Country boundary lookup failed:", str(err)[:160])
    bbox = bbox or FALLBACK_BBOX.get(cc)
    if not bbox:
        raise SystemExit(f"No bounding box for {cc}.")
    bbox = tuple(float(v) for v in bbox)
    xmin, ymin, xmax, ymax = bbox
    log(f"{cc} box: {xmin:.2f},{ymin:.2f} → {xmax:.2f},{ymax:.2f}")

    # Districts and states (county / region areas) with their geometry as WKB for later assignment.
    geom = "ST_AsWKB(geometry)" if "spatial" in loaded else "geometry"
    try:
        name_expr = first_working(con, divisions, ["names.primary", "name"])
        region_expr = first_working(con, divisions, ["region", "NULL"])
        con.execute(f"""COPY (SELECT id, subtype, {name_expr} AS name, {region_expr} AS region, bbox.xmin::DOUBLE AS xmin, bbox.ymin::DOUBLE AS ymin, bbox.xmax::DOUBLE AS xmax, bbox.ymax::DOUBLE AS ymax, {geom} AS wkb
            FROM {divisions} WHERE country=? AND subtype IN ('region','county')) TO '{RAW}/divisions-{cc}.parquet' (FORMAT parquet)""", [cc])
        n = con.execute(f"SELECT subtype, count(*) FROM '{RAW}/divisions-{cc}.parquet' GROUP BY 1").fetchall()
        log("Boundaries:", dict(n))
    except Exception as err:  # noqa: BLE001
        log("Boundary download failed (districts will come from addresses only):", str(err)[:200])

    # Category text from whatever the release carries: categories.{primary,alternate}, taxonomy.*, basic_category.
    cat_parts = working_list(con, places, [
        "coalesce(categories.primary, '')",
        "coalesce(array_to_string(categories.alternate, ' '), '')",
        "coalesce(basic_category, '')",
        "coalesce(taxonomy.primary, '')",
        "coalesce(array_to_string(taxonomy.hierarchy, ' '), '')",
        "coalesce(array_to_string(taxonomy.alternates, ' '), '')",
    ])
    cats = " || ' ' || ".join(cat_parts) if cat_parts else "''"
    lst = lambda field, sub=None: first_working(con, places, [f"array_to_string(list_transform({field}, x -> x.{sub}), ' | ')" if sub else f"array_to_string({field}, ' | ')", "NULL"])
    addr = lambda sub: first_working(con, places, [f"addresses[1].{sub}", "NULL"])
    status = first_working(con, places, ["operating_status", "NULL"])
    conf = first_working(con, places, ["confidence", "NULL"])
    brand = first_working(con, places, ["brand.names.primary", "NULL"])
    src = first_working(con, places, ["array_to_string(list_transform(sources, x -> x.dataset), ',')", "NULL"])
    pattern = prefilter_regex(tax).replace("'", "''")
    sql = f"""
      SELECT id, names.primary AS name, lower({cats}) AS cats,
             ((bbox.ymin + bbox.ymax) / 2)::DOUBLE AS lat, ((bbox.xmin + bbox.xmax) / 2)::DOUBLE AS lon,
             {addr('freeform')} AS address, {addr('locality')} AS locality, {addr('region')} AS region,
             {addr('postcode')} AS postcode, {addr('country')} AS country,
             {lst('phones')} AS phones, {lst('websites')} AS websites, {lst('emails')} AS emails, {lst('socials')} AS socials,
             TRY_CAST({conf} AS DOUBLE) AS confidence, {brand} AS brand, {src} AS datasets, {status} AS operating_status
      FROM {places}
      WHERE bbox.xmin BETWEEN {xmin} AND {xmax} AND bbox.ymin BETWEEN {ymin} AND {ymax}
        AND coalesce({addr('country')}, ?) = ?
        AND regexp_matches(lower({cats}) || ' ' || lower(coalesce(names.primary, '')), '{pattern}')
    """
    out = RAW / f"overture-{cc}.parquet"
    log("Querying Overture places (this reads a few GB from S3 and can take 5–20 minutes)…")
    t0 = time.time()
    con.execute(f"COPY ({sql}) TO '{out}' (FORMAT parquet)", [cc, cc])
    n = con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]
    log(f"Overture: {n:,} candidate places in {time.time() - t0:.0f}s → {out.name}")
    (RAW / f"overture-{cc}.meta.json").write_text(json.dumps({"release": release, "bbox": list(bbox), "fetchedAt": now(), "candidates": n}, indent=2))
    return n


# ------------------------------------------------------------------ OpenStreetMap

OSM_KEYS = {
    "amenity": "events_venue|conference_centre|exhibition_centre|community_centre|social_centre|marriage_hall|wedding_hall|banquet_hall|function_hall|arts_centre|theatre",
    "craft": "caterer|photographer|florist|event_planner|musician|confectionery|photographic_laboratory",
    "shop": "florist|party|wedding|bakery|pastry|cake|costume|photo|photo_studio|rental|bridal|confectionery|printing|stationery|beauty",
    "office": "event_management|event_planner|wedding_planner|events",
    "leisure": "resort",
    "tourism": "resort",
}
OSM_NAME = r"banquet|marriage|wedding|lawns?$|convention|mandap|tent house|caterer|decorator|party hall|kalyana|baraat|barat ghar|samaj bhawan|mangal karyalay|resort|mehndi|mehendi|photo studio|dj |florist|event"


def overpass(query, attempts=6):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for i in range(attempts):
        url = OVERPASS[i % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            return json.loads(urllib.request.urlopen(req, timeout=400).read().decode())
        except urllib.error.HTTPError as err:
            last = f"HTTP {err.code} from {url}"
        except Exception as err:  # noqa: BLE001
            last = f"{type(err).__name__} from {url}: {str(err)[:100]}"
        wait = min(300, 20 * 2 ** i)
        log(f"  Overpass: {last}; retrying in {wait}s")
        time.sleep(wait)
    raise RuntimeError(last or "Overpass failed")


def osm_regions(cc):
    q = f'[out:json][timeout:120];area["ISO3166-1"="{cc}"][admin_level=2]->.c;rel(area.c)["ISO3166-2"~"^{cc}-"][admin_level=4];out tags;'
    rels = overpass(q).get("elements", [])
    regions = sorted({(e["tags"]["ISO3166-2"], e["tags"].get("name:en") or e["tags"].get("name", "")) for e in rels if e.get("tags", {}).get("ISO3166-2")})
    return regions or [(cc, cc)]


def osm_query(iso, level):
    sel = f'area["ISO3166-{level}"="{iso}"]->.a;'
    parts = [f'nwr(area.a)["{k}"~"^({v})$"];' for k, v in OSM_KEYS.items()]
    if os.environ.get("OSM_NAME_SEARCH"):          # slow on public Overpass servers; off by default
        parts.append(f'nwr(area.a)["name"~"{OSM_NAME}",i];')
    return f'[out:json][timeout:360];{sel}({"".join(parts)});out center tags;'


def osm_row(e, region):
    t = e.get("tags", {})
    lat = e.get("lat") or (e.get("center") or {}).get("lat")
    lon = e.get("lon") or (e.get("center") or {}).get("lon")
    cats = " ".join(f"{k} {t[k]}" for k in ("amenity", "craft", "shop", "office", "leisure", "tourism", "building", "cuisine") if k in t)
    addr = ", ".join(t[k] for k in ("addr:housenumber", "addr:street", "addr:suburb", "addr:city", "addr:district", "addr:state", "addr:postcode") if t.get(k))
    return {"id": f"{e['type']}/{e['id']}", "name": t.get("name:en") or t.get("name"), "cats": cats.lower(), "lat": lat, "lon": lon,
            "address": addr or None, "locality": t.get("addr:city") or t.get("addr:suburb"), "region": t.get("addr:state") or region,
            "postcode": t.get("addr:postcode"), "district_tag": t.get("addr:district"),
            "phones": t.get("phone") or t.get("contact:phone") or t.get("contact:mobile"), "websites": t.get("website") or t.get("contact:website"),
            "emails": t.get("email") or t.get("contact:email"), "socials": t.get("contact:facebook") or t.get("contact:instagram"),
            "osm_url": f"https://www.openstreetmap.org/{e['type']}/{e['id']}"}


def fetch_osm(cc, pause=15):
    RAW.mkdir(parents=True, exist_ok=True)
    done_path = RAW / f"osm-{cc}.progress.json"
    done = json.loads(done_path.read_text()) if done_path.exists() else {}
    regions = osm_regions(cc)
    log(f"OSM: {len(regions)} regions for {cc}")
    for iso, name in regions:
        part = RAW / f"osm-{cc}-{iso}.ndjson.gz"
        if done.get(iso) and part.exists():
            continue
        log(f"  {iso} {name}…")
        els = overpass(osm_query(iso, "2" if "-" in iso else "1")).get("elements", [])
        with gzip.open(part, "wt", encoding="utf-8") as f:
            for e in els:
                r = osm_row(e, name)
                if r["name"] and r["lat"] is not None:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
        done[iso] = {"name": name, "elements": len(els), "at": now()}
        done_path.write_text(json.dumps(done, indent=2))
        log(f"  {iso}: {len(els):,} elements")
        time.sleep(pause)
    return sum(v["elements"] for v in done.values())


# ------------------------------------------------------------------ Google (Brahmini's own collectors)

def fetch_google(cc):
    RAW.mkdir(parents=True, exist_ok=True)
    rows = []
    dbs = [APP / "data" / "event-planners" / "collection.db", OUT / f"google-{cc}.db"] if cc == "IN" else [OUT / f"google-{cc}.db"]
    for path in dbs:
        if not path.exists():
            continue
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        has_cat = "category_id" in [r[1] for r in con.execute("PRAGMA table_info(tasks)")]
        for r in con.execute(f"""SELECT b.*, (SELECT t.district FROM discoveries d JOIN tasks t ON t.id=d.task_id WHERE d.business_id=b.id LIMIT 1) AS task_district,
                                 (SELECT t.state FROM discoveries d JOIN tasks t ON t.id=d.task_id WHERE d.business_id=b.id LIMIT 1) AS task_state
                                 {", (SELECT group_concat(DISTINCT t.category_id) FROM discoveries d JOIN tasks t ON t.id=d.task_id WHERE d.business_id=b.id) AS searched" if has_cat else ""}
                                 FROM businesses b"""):
            r = dict(r)
            rows.append({"id": r["id"], "name": r["name"], "cats": (r.get("category") or "").lower(), "lat": r["latitude"], "lon": r["longitude"],
                         "address": r["address"], "region": r["task_state"], "search_district": r["task_district"], "phones": r["phone"],
                         "websites": r["website"], "rating": r["rating"], "reviews": r["reviews"], "maps_url": r["maps_url"],
                         "first_seen": r["first_seen"], "searched": r.get("searched"), "db": path.name})
        con.close()
    with gzip.open(RAW / f"google-{cc}.ndjson.gz", "wt", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"Google (own collectors): {len(rows):,} listings")
    return len(rows)


# ------------------------------------------------------------------ build

STOP = {"the", "and", "pvt", "ltd", "private", "limited", "llp", "india", "co", "company", "services", "service", "&"}


def norm_name(s):
    s = re.sub(r"[^\w\s]", " ", str(s or "").lower())
    return " ".join(w for w in s.split() if w not in STOP)


def digits(phones):
    return sorted({re.sub(r"\D", "", p)[-10:] for p in re.split(r"[|,;/]", str(phones or "")) if len(re.sub(r"\D", "", p)) >= 8})


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class DSU:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


def read_sources(cc):
    rows = []
    ov = RAW / f"overture-{cc}.parquet"
    if ov.exists():
        import duckdb
        con = duckdb.connect()
        cur = con.execute(f"SELECT * FROM '{ov}'")
        cols = [d[0] for d in cur.description]
        for t in cur.fetchall():
            r = dict(zip(cols, t))
            if str(r.get("operating_status") or "").lower() == "permanently_closed":
                continue
            r["source"] = "overture"
            r["source_url"] = f"https://explore.overturemaps.org/#16/{r['lat']}/{r['lon']}"
            rows.append(r)
    for part in sorted(RAW.glob(f"osm-{cc}-*.ndjson.gz")):
        with gzip.open(part, "rt", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                r["source"] = "osm"
                r["source_url"] = r.pop("osm_url", None)
                rows.append(r)
    g = RAW / f"google-{cc}.ndjson.gz"
    if g.exists():
        with gzip.open(g, "rt", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                r["source"] = "google"
                r["source_url"] = r.get("maps_url")
                rows.append(r)
    return rows


def assign_districts(cc, rows):
    """district and state for each row: exact polygon test with DuckDB spatial, else smallest boundary box."""
    path = RAW / f"divisions-{cc}.parquet"
    if not path.exists():
        return "none"
    import duckdb
    con = duckdb.connect()
    divs = con.execute(f"SELECT id, subtype, name, region, xmin::DOUBLE, ymin::DOUBLE, xmax::DOUBLE, ymax::DOUBLE FROM '{path}'").fetchall()
    if not divs:
        return "none"
    pts = [(i, r["lon"], r["lat"]) for i, r in enumerate(rows) if r.get("lat") is not None and r.get("lon") is not None]
    method = "box"
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute("CREATE TABLE pts(i INTEGER, lon DOUBLE, lat DOUBLE)")
        con.executemany("INSERT INTO pts VALUES (?,?,?)", pts)
        for g in ("ST_GeomFromWKB(wkb)", "wkb::GEOMETRY"):
            try:
                con.execute(f"CREATE OR REPLACE TABLE d AS SELECT id, subtype, name, region, xmin, ymin, xmax, ymax, {g} AS g FROM '{path}' WHERE wkb IS NOT NULL")
                break
            except Exception:  # noqa: BLE001
                continue
        hits = con.execute("""SELECT p.i, d.subtype, d.name FROM pts p JOIN d ON p.lon BETWEEN d.xmin AND d.xmax AND p.lat BETWEEN d.ymin AND d.ymax
                              WHERE ST_Contains(d.g, ST_Point(p.lon, p.lat))""").fetchall()
        for i, sub, name in hits:
            rows[i]["district" if sub == "county" else "state"] = name
        method = "polygon"
    except Exception as err:  # noqa: BLE001
        log("Spatial extension unavailable; assigning districts by boundary boxes:", str(err)[:120])
        counties = [d for d in divs if d[1] == "county"]
        regions = [d for d in divs if d[1] == "region"]
        cell = 1.0
        grid = {}
        for d in counties + regions:
            for gx in range(math.floor(d[4] / cell), math.floor(d[6] / cell) + 1):
                for gy in range(math.floor(d[5] / cell), math.floor(d[7] / cell) + 1):
                    grid.setdefault((gx, gy), []).append(d)
        for i, x, y in pts:
            cand = [d for d in grid.get((math.floor(x / cell), math.floor(y / cell)), []) if d[4] <= x <= d[6] and d[5] <= y <= d[7]]
            for sub, key in (("county", "district"), ("region", "state")):
                best = [d for d in cand if d[1] == sub]
                if best:
                    d = min(best, key=lambda d: ((d[4] + d[6]) / 2 - x) ** 2 + ((d[5] + d[7]) / 2 - y) ** 2)
                    rows[i][key] = d[2]
    return method


def build(cc, tax):
    OUT.mkdir(parents=True, exist_ok=True)
    rows = read_sources(cc)
    log(f"Build {cc}: {len(rows):,} source rows")
    kept = []
    for r in rows:
        if not r.get("name") or r.get("lat") is None or r.get("lon") is None:
            continue
        ids, basis = classify(tax, r.get("cats"), r.get("name"))
        if not ids:
            continue
        r["categories"], r["match_basis"] = ids, basis
        kept.append(r)
    log(f"Event-related: {len(kept):,}")
    method = assign_districts(cc, kept)
    for r in kept:
        r.setdefault("state", None)
        r["state"] = r.get("state") or r.get("region")
        r["district"] = r.get("district") or r.get("district_tag") or r.get("search_district")

    # Merge duplicates: same normalised name within ~200 m, or same phone number within ~1 km.
    dsu, cellsz = DSU(len(kept)), 0.002
    by_name, by_phone = {}, {}
    for i, r in enumerate(kept):
        r["_n"] = norm_name(r["name"])
        cx, cy = math.floor(r["lon"] / cellsz), math.floor(r["lat"] / cellsz)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in by_name.get((r["_n"], cx + dx, cy + dy), []):
                    dsu.union(i, j)
        by_name.setdefault((r["_n"], cx, cy), []).append(i)
        for ph in digits(r.get("phones")):
            for j in by_phone.get(ph, []):
                if abs(kept[j]["lat"] - r["lat"]) < 0.01 and abs(kept[j]["lon"] - r["lon"]) < 0.01:
                    dsu.union(i, j)
            by_phone.setdefault(ph, []).append(i)
    groups = {}
    for i in range(len(kept)):
        groups.setdefault(dsu.find(i), []).append(kept[i])

    order = [c["id"] for c in tax["categories"]]
    places, links = [], []
    for members in groups.values():
        members.sort(key=lambda r: (SOURCE_RANK[r["source"]], 0 if r["match_basis"] == "category" else 1))
        top = members[0]
        pick = lambda k: next((m.get(k) for m in members if m.get(k) not in (None, "")), None)
        cats = sorted({c for m in members for c in m["categories"]}, key=order.index)
        basis = "category" if any(m["match_basis"] == "category" for m in members) else "name"
        primary = next((c for m in members if m["match_basis"] == basis for c in m["categories"]), cats[0])
        pid = "ev_" + hashlib.sha1("|".join(sorted(f"{m['source']}:{m['id']}" for m in members)).encode()).hexdigest()[:16]
        phones = sorted({p for m in members for p in re.split(r"\s*\|\s*", str(m.get("phones") or "")) if p.strip()})
        places.append({
            "id": pid, "name": top["name"], "primary_category": primary, "group": primary.split(".")[0],
            "categories": ",".join(cats), "match_basis": basis,
            "lat": round(top["lat"], 6), "lon": round(top["lon"], 6), "address": pick("address"), "locality": pick("locality"),
            "district": pick("district"), "state": pick("state"), "postcode": pick("postcode"), "country": cc,
            "phones": " | ".join(phones) or None, "websites": pick("websites"), "emails": pick("emails"), "socials": pick("socials"),
            "rating": pick("rating"), "reviews": pick("reviews"), "overture_confidence": pick("confidence"),
            "sources": ",".join(sorted({m["source"] for m in members}, key=SOURCE_RANK.get)), "source_count": len(members),
            "source_urls": " | ".join(sorted({m["source_url"] for m in members if m.get("source_url")})),
        })
        for m in members:
            links.append((pid, m["source"], str(m["id"]), m.get("source_url"), m.get("cats"), m["match_basis"], LICENCE[m["source"]]))
    places.sort(key=lambda p: (p["state"] or "~", p["district"] or "~", p["primary_category"], p["name"]))
    log(f"Places after merging duplicates: {len(places):,}")

    # SQLite
    db_path = OUT / "directory.db"
    con = sqlite3.connect(db_path)
    con.executescript("""
      CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, name TEXT, primary_category TEXT, "group" TEXT, categories TEXT, match_basis TEXT,
        lat REAL, lon REAL, address TEXT, locality TEXT, district TEXT, state TEXT, postcode TEXT, country TEXT, phones TEXT, websites TEXT,
        emails TEXT, socials TEXT, rating TEXT, reviews TEXT, overture_confidence REAL, sources TEXT, source_count INTEGER, source_urls TEXT, built_at TEXT);
      CREATE TABLE IF NOT EXISTS place_sources (place_id TEXT, source TEXT, source_id TEXT, source_url TEXT, source_categories TEXT, match_basis TEXT, licence TEXT);
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, "group" TEXT, label TEXT, google_query TEXT);
      CREATE TABLE IF NOT EXISTS builds (country TEXT PRIMARY KEY, built_at TEXT, info TEXT);
      CREATE INDEX IF NOT EXISTS places_where ON places(country, state, district, primary_category);
      CREATE INDEX IF NOT EXISTS place_sources_place ON place_sources(place_id);
    """)
    con.execute("DELETE FROM place_sources WHERE place_id IN (SELECT id FROM places WHERE country=?)", [cc])
    con.execute("DELETE FROM places WHERE country=?", [cc])
    built = now()
    cols = list(places[0].keys()) + ["built_at"] if places else []
    if places:
        con.executemany(f'INSERT INTO places ({",".join(chr(34) + c + chr(34) for c in cols)}) VALUES ({",".join("?" * len(cols))})', [tuple(p.values()) + (built,) for p in places])
        con.executemany("INSERT INTO place_sources VALUES (?,?,?,?,?,?,?)", links)
    con.executemany("INSERT OR REPLACE INTO categories VALUES (?,?,?,?)", [(c["id"], c["group"], c["label"], c["google"]) for c in tax["categories"]])
    counts = {s: sum(1 for r in rows if r["source"] == s) for s in SOURCE_RANK}
    info = {"sourceRows": counts, "eventRelated": len(kept), "places": len(places), "districtMethod": method}
    con.execute("INSERT OR REPLACE INTO builds VALUES (?,?,?)", [cc, built, json.dumps(info)])
    con.commit()
    con.close()

    # CSV (spreadsheet-safe)
    safe = lambda v: ("'" + str(v)) if isinstance(v, str) and v[:1] in "=+-@\t\r" else v
    with open(OUT / f"event-directory-{cc}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if places:
            w.writerow(places[0].keys())
            for p in places:
                w.writerow([safe(v) for v in p.values()])

    write_summary_and_gaps(cc, tax, places, info)
    return info


def district_key(s):
    s = re.sub(r"\b(district|dist|zila|jilla)\b", " ", str(s or "").lower())
    return re.sub(r"[^a-z]", "", s)


def write_summary_and_gaps(cc, tax, places, info):
    labels = {c["id"]: c["label"] for c in tax["categories"]}
    by_cat, by_state, by_src = {}, {}, {}
    for p in places:
        by_cat[p["primary_category"]] = by_cat.get(p["primary_category"], 0) + 1
        by_state[p["state"] or "(unknown)"] = by_state.get(p["state"] or "(unknown)", 0) + 1
        by_src[p["sources"]] = by_src.get(p["sources"], 0) + 1
    lines = [f"# Event directory · {cc} · {now()}", "",
             f"{info['places']:,} places from {sum(info['sourceRows'].values()):,} source rows "
             f"(Overture {info['sourceRows']['overture']:,} · OpenStreetMap {info['sourceRows']['osm']:,} · Google {info['sourceRows']['google']:,}). "
             f"Districts assigned by {info['districtMethod']}.", "",
             "Listings are what the sources publish, not a verified census. `match_basis=name` rows were matched on the name only; check them before use.", "",
             "## By category", "", "| Category | Places |", "|---|---:|"]
    lines += [f"| {labels[c]} | {n:,} |" for c, n in sorted(by_cat.items(), key=lambda x: -x[1])]
    lines += ["", "## By state / region", "", "| State | Places |", "|---|---:|"]
    lines += [f"| {s} | {n:,} |" for s, n in sorted(by_state.items(), key=lambda x: -x[1])]
    lines += ["", "## By source combination", "", "| Sources | Places |", "|---|---:|"]
    lines += [f"| {s} | {n:,} |" for s, n in sorted(by_src.items(), key=lambda x: -x[1])]

    # Gaps: India uses the iGOD district list the Google collector already searches.
    gaps = []
    frame = APP / "data" / "event-planners" / "districts.json"
    if cc == "IN" and frame.exists():
        districts = json.loads(frame.read_text())["districts"]
        have = {}
        for p in places:
            for c in p["categories"].split(","):
                k = (district_key(p["district"]), c)
                have[k] = have.get(k, 0) + 1
        for d in districts:
            for c in tax["categories"]:
                n = have.get((district_key(d["name"]), c["id"]), 0)
                if n < c["gapMin"]:
                    gaps.append({"key": d["key"], "district": d["name"], "state": d["state"], "stateCode": d["stateCode"],
                                 "category": c["id"], "have": n, "want": c["gapMin"], "query": f"{c['google']} in {d['name']} district, {d['state']}, India"})
        gaps.sort(key=lambda g: (g["have"] > 0, [x["id"] for x in tax["categories"]].index(g["category"]), g["state"], g["district"]))
        (OUT / f"gaps-{cc}.json").write_text(json.dumps({"country": cc, "builtAt": now(), "count": len(gaps), "gaps": gaps}, indent=1, ensure_ascii=False))
        empty = sum(1 for g in gaps if g["have"] == 0)
        lines += ["", "## Gaps (India)", "", f"{len(gaps):,} district × category combinations have fewer places than wanted ({empty:,} have none). "
                  "`Fill event directory gaps from Google.command` searches them, emptiest first."]
    (OUT / f"summary-{cc}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"Summary → {OUT / f'summary-{cc}.md'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["overture", "osm", "google", "build", "all"])
    ap.add_argument("--country", default="IN", help="ISO 3166-1 alpha-2 code, e.g. IN, AE, GB (default IN)")
    ap.add_argument("--overture-source", help="read Overture parquet from a local folder instead of S3 (tests)")
    ap.add_argument("--skip", default="", help="comma list of stages to skip in 'all', e.g. osm")
    ap.add_argument("--refresh", action="store_true", help="download Overture again and redo every OSM region")
    a = ap.parse_args()
    cc, tax, skip = a.country.upper(), load_taxonomy(), set(filter(None, a.skip.split(",")))
    stages = ["overture", "osm", "google", "build"] if a.stage == "all" else [a.stage]
    for s in stages:
        if s in skip:
            continue
        try:
            if s == "overture":
                ov = RAW / f"overture-{cc}.parquet"
                if a.stage == "all" and not a.refresh and ov.exists() and (RAW / f"overture-{cc}.meta.json").exists() and time.time() - ov.stat().st_mtime < 7 * 86400:
                    log(f"Overture data for {cc} is less than a week old; reusing it (--refresh to download again).")
                    continue
                fetch_overture(cc, tax, a.overture_source)
            elif s == "osm":
                if a.refresh:
                    (RAW / f"osm-{cc}.progress.json").unlink(missing_ok=True)
                fetch_osm(cc)
            elif s == "google":
                fetch_google(cc)
            else:
                info = build(cc, tax)
                log("Done:", json.dumps(info))
        except KeyboardInterrupt:
            raise
        except Exception as err:  # noqa: BLE001
            if a.stage != "all" or s == "build":
                raise
            log(f"Stage {s} failed: {err}. Continuing with what is available.")


if __name__ == "__main__":
    main()
