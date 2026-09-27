#!/usr/bin/env python3
"""Brahmini event directory — geospatial layer.

Runs after `event_directory.py build`. For one country (India by default) it:
  1. reads population on H3 hexagons from Kontur Population (CC BY 4.0), downloading it once;
  2. sums places and people on H3 hexagons: resolution 5 (~250 km², for the map) and 7 (~5 km²);
  3. measures, for every populated ~5 km² hexagon, the straight-line distance to the nearest
     supplier of each core event trade (venue, caterer, décor/tent, photographer, DJ/sound, planner);
  4. writes district figures (places and venues per 100,000 people; people living more than
     25 km from each trade), underserved hexagons, and GIS files (GeoParquet, GeoPackage, GeoJSON);
  5. re-orders gaps-<CC>.json so Google gap searches go first where most people are far from a supplier;
  6. writes the data for the map page (india-scraper-next/public/event-directory/).

Distances are straight lines between hexagon centres and listed places, not travel times.
Needs: duckdb, h3, numpy, scipy (the Build/Map double-click scripts install them).
"""
import argparse, csv, gzip, json, os, re, shutil, sqlite3, subprocess, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import event_directory as ed  # noqa: E402

import h3  # noqa: E402
import numpy as np  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402

OUT, RAW, APP = ed.OUT, ed.RAW, ed.APP
GEO = OUT / "geo"
WEB = Path(os.environ.get("EVENT_MAP_DIR", APP / "public" / "event-directory" / "data"))
KONTUR = {
    "IN": [
        "https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_IN_20231101.gpkg.gz",
        "https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_IN_20220630.gpkg.gz",
    ],
}
TRADES = {
    "venue": ("Event venue", list(ed.VENUE_CORE)),
    "caterer": ("Caterer", ["vendor.caterer"]),
    "decor": ("Décor / tent house", ["vendor.decor_tent"]),
    "photo": ("Photographer", ["vendor.photo_video"]),
    "sound": ("DJ / sound / light", ["vendor.dj_sound_light"]),
    "planner": ("Event / wedding planner", ["vendor.event_planner", "planning.wedding_planner"]),
}
FAR_KM = 25.0
EARTH_KM = 6371.0088
log = ed.log


# ------------------------------------------------------------------ population

def kontur_path(cc, given=None):
    """Kontur population GeoPackage: the given file, raw/kontur-<CC>.gpkg(.gz), or a one-time download (~100-200 MB)."""
    if given:
        given = Path(given)
        return gunzip(given) if given.suffix == ".gz" else given
    gpkg = RAW / f"kontur-{cc}.gpkg"
    if gpkg.exists():
        return gpkg
    for gz in [RAW / (gpkg.name + ".gz")] + sorted(RAW.glob(f"kontur_population_{cc}_*.gpkg.gz")):
        if gz.exists():
            return gunzip(gz, gpkg)
    RAW.mkdir(parents=True, exist_ok=True)
    part = RAW / (gpkg.name + ".gz.part")
    for url in KONTUR.get(cc, []):
        log(f"Downloading population hexagons (Kontur) from {url.rsplit('/', 1)[-1]}…")
        try:
            if shutil.which("curl"):
                subprocess.run(["curl", "-fL", "--retry", "3", "-sS", "-A", ed.UA, "-o", str(part), url], check=True)
            else:
                req = urllib.request.Request(url, headers={"User-Agent": ed.UA})
                with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as f:
                    shutil.copyfileobj(r, f, 1 << 20)
            return gunzip(part, gpkg)
        except Exception as err:  # noqa: BLE001
            log(f"  population download failed: {str(err)[:120]}")
            part.unlink(missing_ok=True)
    log(f"Get 'Kontur Population: India' (GeoPackage) from https://data.humdata.org and put the .gpkg.gz in {RAW}, then run again.")
    return None


def gunzip(gz, dest=None):
    dest = Path(dest or str(gz).removesuffix(".gz"))
    with gzip.open(gz, "rb") as src, open(str(dest) + ".part", "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(str(dest) + ".part", dest)
    if gz.name.endswith(".part"):
        gz.unlink(missing_ok=True)
    return dest


def read_population(path, res=7):
    """{H3 cell at `res`: people}, summed up from a Kontur GeoPackage (a table with h3 and population columns)."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        cols = [r[1].lower() for r in con.execute(f'PRAGMA table_info("{t}")')]
        if "h3" in cols and "population" in cols:
            out, parent = {}, {}
            for h, p in con.execute(f'SELECT h3, population FROM "{t}"'):
                try:
                    c = h3.cell_to_parent(h, res) if h3.get_resolution(h) > res else h
                except Exception:  # noqa: BLE001
                    continue
                out[c] = out.get(c, 0.0) + float(p or 0)
            return out
    raise SystemExit(f"{path} has no table with h3 and population columns")


# ------------------------------------------------------------------ helpers

def xyz(lat, lon):
    lat, lon = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_km(ch):
    return 2 * EARTH_KM * np.arcsin(np.clip(ch / 2, 0, 1))


def fkey(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "unknown").lower()).strip("-") or "unknown"


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


# ------------------------------------------------------------------ main work

def run(cc, tax, kontur_file=None, far_km=FAR_KM):
    GEO.mkdir(parents=True, exist_ok=True)
    cats = [c["id"] for c in tax["categories"]]
    ci = {c: i for i, c in enumerate(cats)}
    fam_ids = [f["id"] for f in tax["families"]]
    fam_of = ed.family_of(tax)
    cat_types = ed.category_event_types(tax, ed.parse_checklist())

    con = sqlite3.connect(f"file:{OUT / 'directory.db'}?mode=ro", uri=True)
    rows = con.execute("""SELECT id, name, primary_category, categories, lat, lon, district, state, substr(phones, 1, 60), substr(websites, 1, 200),
                          rating, reviews, sources, match_basis, substr(source_urls, 1, 300) FROM places WHERE country=? AND lat IS NOT NULL""", [cc]).fetchall()
    log(f"{len(rows):,} places")
    lat = np.array([r[4] for r in rows], dtype=float)
    lon = np.array([r[5] for r in rows], dtype=float)
    prim = [r[2] for r in rows]

    # 1. population
    pop7 = {}
    path = kontur_path(cc, kontur_file)
    if path:
        pop7 = read_population(path, 7)
        log(f"Population: {sum(pop7.values()):,.0f} people on {len(pop7):,} hexagons of ~5 km²")
    else:
        log("No population data: per-person figures and distance-to-supplier by population are skipped.")
    pop5 = {}
    for c7, p in pop7.items():
        c5 = h3.cell_to_parent(c7, 5)
        pop5[c5] = pop5.get(c5, 0) + p

    # 2. places on hexagons
    hex5 = {}
    for r, la, lo in zip(rows, lat, lon):
        c5 = h3.latlng_to_cell(la, lo, 5)
        d = hex5.setdefault(c5, {})
        k = ci.get(r[2])
        if k is not None:
            d[k] = d.get(k, 0) + 1
    cells5 = set(hex5) | {c for c, p in pop5.items() if p >= 1}

    # 3. distance to the nearest supplier, for every populated ~5 km² hexagon
    c7s = [c for c, p in pop7.items() if p >= 1]
    far = {}
    nearest = {}
    if c7s:
        cl = np.array([h3.cell_to_latlng(c) for c in c7s])
        pts = xyz(cl[:, 0], cl[:, 1])
        P = np.array([pop7[c] for c in c7s])
        for t, (_, ids) in TRADES.items():
            mask = np.array([p in ids for p in prim])
            if not mask.any():
                nearest[t] = np.full(len(c7s), np.inf)
                far[t] = float(P.sum())
                continue
            tree = cKDTree(xyz(lat[mask], lon[mask]))
            ch, _ = tree.query(pts, k=1)
            nearest[t] = chord_km(ch)
            far[t] = float(P[nearest[t] > far_km].sum())
            log(f"  {TRADES[t][0]}: {far[t]:,.0f} people ({100 * far[t] / P.sum():.1f}%) live more than {far_km:.0f} km from one")
        # districts for the hexagons (exact polygons when DuckDB spatial is available)
        hexrows = [{"lat": float(a), "lon": float(b)} for a, b in cl]
        method = ed.assign_districts(cc, hexrows)
        names = ed.region_names(cc)
        for h in hexrows:
            h["state"] = ed.normalise_state(cc, h.get("state"), names)
        log(f"Hexagons placed in districts by {method}")
    else:
        hexrows, P, cl = [], np.array([]), np.zeros((0, 2))

    # 4. district figures
    dist = {}
    for r in rows:
        k = (r[7] or "(unknown)", r[6] or "(unknown)")
        d = dist.setdefault(k, {"places": 0, "venues": 0, "pop": 0.0, "far": {t: 0.0 for t in TRADES}, "wdist": {t: 0.0 for t in TRADES}})
        d["places"] += 1
        if r[2] in ed.VENUE_CORE:
            d["venues"] += 1
    for i, h in enumerate(hexrows):
        k = (h.get("state") or "(unknown)", h.get("district") or "(unknown)")
        d = dist.setdefault(k, {"places": 0, "venues": 0, "pop": 0.0, "far": {t: 0.0 for t in TRADES}, "wdist": {t: 0.0 for t in TRADES}})
        d["pop"] += P[i]
        for t in TRADES:
            dk = nearest[t][i]
            if dk > far_km:
                d["far"][t] += P[i]
            d["wdist"][t] += P[i] * min(dk, 500)
    per100k = lambda n, p: round(n / p * 1e5, 1) if p >= 1000 else None
    with open(GEO / f"districts-geo-{cc}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["state", "district", "population", "places", "venues", "places_per_100k", "venues_per_100k"]
                   + [f"people_over_{int(far_km)}km_{t}" for t in TRADES] + [f"share_over_{int(far_km)}km_{t}" for t in TRADES]
                   + [f"mean_km_to_{t}" for t in TRADES])
        for (st, di), d in sorted(dist.items()):
            p = d["pop"]
            w.writerow([st, di, round(p), d["places"], d["venues"], per100k(d["places"], p), per100k(d["venues"], p)]
                       + [round(d["far"][t]) for t in TRADES] + [round(100 * d["far"][t] / p, 1) if p else None for t in TRADES]
                       + [round(d["wdist"][t] / p, 1) if p else None for t in TRADES])

    # underserved hexagons: at least 500 people and some core trade beyond far_km
    under = []
    for i, c in enumerate(c7s):
        if P[i] < 500:
            continue
        far_t = [t for t in TRADES if nearest[t][i] > far_km]
        if far_t:
            under.append((c, float(cl[i, 0]), float(cl[i, 1]), hexrows[i].get("district"), hexrows[i].get("state"), round(P[i]),
                          {t: round(float(min(nearest[t][i], 9999)), 1) for t in TRADES}))
    under.sort(key=lambda u: -u[5])
    with open(GEO / f"underserved-{cc}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["h3", "lat", "lon", "district", "state", "population"] + [f"km_to_{t}" for t in TRADES])
        for u in under:
            w.writerow(list(u[:6]) + [u[6][t] for t in TRADES])
    log(f"{len(under):,} populated hexagons are more than {far_km:.0f} km from at least one core trade")

    # 5. GIS files (best effort; need DuckDB spatial)
    write_gis(cc, con, dist, far_km)

    # 6. Google gaps: go first where most people are far from a supplier
    reprioritise_gaps(cc, dist)

    # 7. map data
    write_web(cc, tax, rows, cats, fam_ids, fam_of, cat_types, hex5, pop5, cells5, dist, under, far, P, far_km)
    summary = {"country": cc, "builtAt": ed.now(), "places": len(rows), "population": float(P.sum()) if len(P) else None,
               "farKm": far_km, "peopleFar": far, "underservedHexagons": len(under), "hex5": len(cells5)}
    (GEO / f"geo-summary-{cc}.json").write_text(json.dumps(summary, indent=2))
    return summary


def write_gis(cc, con, dist, far_km):
    try:
        import duckdb
        d = duckdb.connect()
        d.execute("INSTALL spatial; LOAD spatial;")
    except Exception as err:  # noqa: BLE001
        log(f"GIS files skipped (DuckDB spatial unavailable: {str(err)[:80]})")
        return
    db = OUT / "directory.db"
    try:
        d.execute("INSTALL sqlite; LOAD sqlite;")
        d.execute(f"ATTACH '{db}' AS dir (TYPE sqlite, READ_ONLY)")
        sel = f"""SELECT id, name, family, primary_category, categories, event_types, match_basis, district, state, phones, websites,
                  rating, reviews, sources, ST_Point(lon, lat) AS geometry FROM dir.places WHERE country='{cc}' AND lat IS NOT NULL"""
        d.execute(f"COPY ({sel}) TO '{GEO / f'places-{cc}.parquet'}' (FORMAT parquet)")
        log(f"GeoParquet → {GEO / f'places-{cc}.parquet'}")
        try:
            gp = GEO / f"places-{cc}.gpkg"
            gp.unlink(missing_ok=True)
            d.execute(f"COPY ({sel}) TO '{gp}' WITH (FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326')")
            log(f"GeoPackage → {gp}")
        except Exception as err:  # noqa: BLE001
            log(f"GeoPackage skipped: {str(err)[:100]}")
    except Exception as err:  # noqa: BLE001
        log(f"Place files skipped: {str(err)[:120]}")
    div = RAW / f"divisions-{cc}.parquet"
    if not div.exists():
        return
    try:
        rows = []
        for st_code, name, gj in d.execute(f"""SELECT region, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(
                ST_GeomFromWKB(wkb), 0.01)) FROM '{div}' WHERE subtype='county' AND wkb IS NOT NULL""").fetchall():
            rows.append((st_code, name, gj))
    except Exception:  # noqa: BLE001
        try:
            rows = d.execute(f"""SELECT region, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(wkb::GEOMETRY, 0.01))
                    FROM '{div}' WHERE subtype='county' AND wkb IS NOT NULL""").fetchall()
        except Exception as err:  # noqa: BLE001
            log(f"District boundaries skipped: {str(err)[:100]}")
            return
    names = ed.region_names(cc)
    feats = []
    for code, name, gj in rows:
        st = ed.normalise_state(cc, code, names)
        v = dist.get((st, name))
        props = {"district": name, "state": st}
        if v:
            p = v["pop"]
            props.update({"population": round(p), "places": v["places"], "venues": v["venues"],
                          "places_per_100k": round(v["places"] / p * 1e5, 1) if p >= 1000 else None,
                          "venues_per_100k": round(v["venues"] / p * 1e5, 2) if p >= 1000 else None})
            props.update({f"share_over_{int(far_km)}km_{t}": round(100 * v["far"][t] / p, 1) if p else None for t in TRADES})
        feats.append({"type": "Feature", "properties": props, "geometry": json.loads(gj)})
    fc = {"type": "FeatureCollection", "features": feats}
    (GEO / f"districts-{cc}.geojson").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    dump(WEB / "districts.geojson", fc)
    log(f"District boundaries with figures → {GEO / f'districts-{cc}.geojson'}")


def reprioritise_gaps(cc, dist):
    path = OUT / f"gaps-{cc}.json"
    if not path.exists():
        return
    g = json.loads(path.read_text())
    by_key, by_pair = {}, {}
    for (st, di), v in dist.items():
        by_key.setdefault(ed.district_key(di), v)
        by_pair[(ed.district_key(st), ed.district_key(di))] = v
    trade_of = {c: t for t, (_, ids) in TRADES.items() for c in ids}
    venue_boosted = set()   # one venue search per venue-less district goes first; the rest follow by population
    for i, gap in enumerate(g["gaps"]):
        v = by_pair.get((ed.district_key(gap.get("state")), ed.district_key(gap["district"]))) or by_key.get(ed.district_key(gap["district"]))
        t = trade_of.get(gap["category"])
        score, why = 0.0, []
        if v and t:
            score += v["far"][t]
            if v["far"][t] >= 1000:
                why.append(f"{v['far'][t]:,.0f} people over {FAR_KM:.0f} km from any {TRADES[t][0].lower()}")
        dk = (ed.district_key(gap.get("state")), ed.district_key(gap["district"]))
        if v and v["venues"] == 0 and gap["category"].startswith("venue."):
            why.append("no venue listed")
            if dk not in venue_boosted:
                venue_boosted.add(dk)
                score += 2e6
        if v and v["places"] < 50:
            score += 5e5
            why.append("fewer than 50 places listed")
        gap["score"], gap["reason"], gap["_i"] = round(score), "; ".join(why), i
    g["gaps"].sort(key=lambda x: (-x["score"], x["_i"]))
    for gap in g["gaps"]:
        gap.pop("_i", None)
    g["orderedBy"] = "people far from the trade, districts with no venue, thin districts; then the build's order"
    path.write_text(json.dumps(g, indent=1, ensure_ascii=False))
    top = [x for x in g["gaps"] if x["score"] > 0]
    log(f"Gap searches re-ordered: {len(top):,} of {len(g['gaps']):,} have a geographic reason to go first")


def write_web(cc, tax, rows, cats, fam_ids, fam_of, cat_types, hex5, pop5, cells5, dist, under, far, P, far_km):
    WEB.mkdir(parents=True, exist_ok=True)
    fams = tax["families"]
    fi = {f["id"]: i for i, f in enumerate(fams)}
    trade_idx = {t: [cats.index(c) for c in ids if c in cats] for t, (_, ids) in TRADES.items()}
    meta = {
        "country": cc, "builtAt": ed.now(), "farKm": far_km,
        "families": [{"id": f["id"], "label": f["label"]} for f in fams],
        "categories": [{"id": c["id"], "label": c["label"], "family": fi[fam_of[c["id"]]], "eventTypes": cat_types.get(c["id"], [])} for c in tax["categories"]],
        "eventTypes": ed.parse_checklist()["codes"],
        "trades": [{"id": t, "label": TRADES[t][0], "categories": trade_idx[t]} for t in TRADES],
        "population": float(P.sum()) if len(P) else None,
        "peopleFar": far, "places": len(rows),
    }
    dump(WEB / "meta.json", meta)
    hexes = []
    for c in cells5:
        b = [[round(a, 3), round(o, 3)] for a, o in h3.cell_to_boundary(c)]
        hexes.append([c, round(pop5.get(c, 0)), hex5.get(c, {}), b])
    dump(WEB / "hex5.json", hexes)
    dump(WEB / "underserved.json", [[round(u[1], 4), round(u[2], 4), u[5], [u[6][t] for t in TRADES], u[3], u[4]] for u in under[:60000]])
    # places, one file per district, loaded when the map zooms in
    groups = {}
    srcbit = {"google": 1, "overture": 2, "osm": 4}
    for r in rows:
        k = fkey(f"{r[7]}-{r[6]}")
        url = (r[14] or "").split(" | ")[0]
        groups.setdefault(k, {"state": r[7], "district": r[6], "items": []})["items"].append([
            r[1], cats.index(r[2]) if r[2] in cats else -1, round(r[4], 5), round(r[5], 5),
            (r[8] or "").split(" | ")[0], (r[9] or "").split(" | ")[0], r[10] or "", r[11] or "",
            sum(srcbit.get(s, 0) for s in (r[12] or "").split(",")), 1 if r[13] == "name" else 0, url])
    pdir = WEB / "places"
    pdir.mkdir(parents=True, exist_ok=True)
    index = []
    for k, g in groups.items():
        la = [x[2] for x in g["items"]]
        lo = [x[3] for x in g["items"]]
        dump(pdir / f"{k}.json", g["items"])
        v = dist.get((g["state"] or "(unknown)", g["district"] or "(unknown)"), {})
        index.append({"key": k, "state": g["state"], "district": g["district"], "n": len(g["items"]),
                      "bbox": [min(la), min(lo), max(la), max(lo)], "pop": round(v.get("pop", 0)) if v else None,
                      "venues": v.get("venues") if v else None})
    index.sort(key=lambda x: (x["state"] or "~", x["district"] or "~"))
    dump(WEB / "districts-index.json", index)
    log(f"Map data → {WEB} ({len(hexes):,} hexagons, {len(index):,} district place files)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", default="IN")
    ap.add_argument("--kontur-file", help="use this Kontur population GeoPackage instead of downloading")
    ap.add_argument("--far-km", type=float, default=FAR_KM)
    a = ap.parse_args()
    s = run(a.country.upper(), ed.load_taxonomy(), a.kontur_file, a.far_km)
    log("Done: " + json.dumps({k: v for k, v in s.items() if k != "peopleFar"}))


if __name__ == "__main__":
    main()
