# Event directory: venues and vendors, country by country

A directory of event venues and vendors, built India first and extendable to any country with the same method. Everything stays local in `data/event-directory/` (ignored by Git).

## What counts

`scripts/event-directory/taxonomy.json` defines 80 categories in 13 families: Venue & location · Planning & production · Design & décor · Technical production · Food & hospitality · Talent & entertainment · Photo, film & broadcast · Guest experience · Travel & logistics · Safety, permits & compliance · Branding & fabrication · Digital experience · Personal style & beauty. Every place carries its `family` and `primary_category`; `summary-<CC>.md` has a state × family table.

Broad categories (listed under `generic`, such as Overture's catch-all "party and event planning" or "printing service") give way to a specific name: "… Mangal Karyalay" becomes a banquet hall, "… Flex Printing" signage.

Each category has a regex for source categories/tags, one for names (with Indian terms such as *kalyana mandapam*, *mangal karyalay*, *halwai*, *shamiana*), a Google search phrase and a per-district "gap" threshold. Edit the file to tune it; rebuild to apply.

## Sources

| Source | Stage | Licence | Notes |
|---|---|---|---|
| Overture Maps Places | `overture` | CDLA-Permissive-2.0 (ODbL where from OSM) | Read directly from Overture's public S3 bucket with DuckDB, filtered to the country's box and address country. Also fetches district (county) and state boundaries. |
| OpenStreetMap | `osm` | ODbL-1.0 | Overpass API, one state at a time, resumable (`raw/osm-<CC>.progress.json`). |
| Google Maps (own collectors) | `google` | Google's terms | Imports the event-planner survey (`data/event-planners/collection.db`) and gap runs (`data/event-directory/google-IN.db`). India only. |

## Event types

[EVENT-PLANNING-CHECKLIST.md](EVENT-PLANNING-CHECKLIST.md) lists 13 event type codes (ALL, CONF, EXPO, LAUNCH, FEST, WED, GALA, CORP, SPORT, HYBRID, RETAIL, ROAD, NET) and about 300 planning items tagged with them, in the same 13 families. In `taxonomy.json` each category names the checklist items it supplies (`serves`); its event types are those items' codes, or its own `eventTypes` for trades the checklist does not name (banquet halls, pandits, mehndi). Every place gets `event_types` in `directory.db`.

```sh
python3 scripts/event-directory/event_directory.py report --event WED              # state x family counts for weddings
python3 scripts/event-directory/event_directory.py report --event LAUNCH,HYBRID --state Maharashtra
python3 scripts/event-directory/event_directory.py checklist --event CONF           # the checklist for a conference, with supplier categories
```

A place or item belongs to an event when it is tagged ALL or any of the event's codes. Reports are written to `data/event-directory/report-<CC>-<CODES>.md` and `checklist-<CODES>.md`.

## Build

Double-click **Build event directory.command** in the brahmini folder (asks for a country code, default IN), or:

```sh
python3 scripts/event-directory/event_directory.py all --country IN   # needs: pip install duckdb
```

`build` classifies every source row (category match first, then name match, marked `match_basis`), assigns district and state from Overture boundaries (exact polygons with DuckDB spatial; boundary boxes otherwise), merges duplicates (same normalised name within ~200 m, or the same phone within ~1 km) and writes:

- `directory.db`: `places` (one row per merged place), `place_sources` (every source record with id, URL, original categories and licence), `categories`, `builds`;
- `event-directory-<CC>.csv` (spreadsheet-safe);
- `summary-<CC>.md`: counts by category, state and source combination;
- `gaps-IN.json`: district × category combinations below the threshold, using the 784-district iGOD frame the survey uses.

## Fill gaps from Google (India)

Double-click **Fill event directory gaps from Google.command**. It installs the app's packages once (using your Google Chrome), searches up to 300 gaps per run, in the order of `gaps-IN.json` (by population need once the map has been built; emptiest first otherwise), with the survey's own search code, then rebuilds. A Google access challenge, consent page or HTTP 403/429 stops the run; it stays stopped until you have checked Google Maps yourself and create `data/event-directory/REVIEWED`. Create `data/event-directory/PAUSE` to stop after the current search. A full pass over every gap is thousands of searches and takes days of runs.

## Map, population and distance to suppliers

Double-click **Build event map.command**. The first time it installs `h3`, `numpy` and `scipy`, downloads population on H3 hexagons from [Kontur Population](https://data.humdata.org/organization/kontur) (CC BY 4.0, about 150 MB once, kept in `raw/kontur-IN.gpkg`), runs `scripts/event-directory/geo.py` and opens the map at `http://127.0.0.1:8791/event-directory/`. Later double-clicks just open the map, unless the directory was rebuilt since (`--rebuild` forces it). If the download is blocked, get "Kontur Population: India" (GeoPackage) from HDX yourself, put the `.gpkg.gz` in `data/event-directory/raw/` and run again.

`geo.py` measures, for every populated ~5 km² hexagon (H3 resolution 7), the straight-line distance to the nearest listed supplier of six core trades: event venue, caterer, décor/tent house, photographer, DJ/sound/light and event/wedding planner. It writes, in `data/event-directory/geo/`:

- `districts-geo-IN.csv`: population, places and venues per 100,000 people, people and share living more than 25 km from each trade, and the population-weighted mean distance;
- `underserved-IN.csv`: hexagons with at least 500 people and some trade more than 25 km away;
- `places-IN.parquet` (GeoParquet) and `places-IN.gpkg`, and `districts-IN.geojson` with the district figures (when DuckDB's spatial extension is available);
- `geo-summary-IN.json`.

It also re-orders `gaps-IN.json` so the Google gap searches go first where they help most people: districts with no venue, people far from the gap's trade, and districts with fewer than 50 places. Each gap gets a `score` and a `reason`. Rebuilding re-runs `geo.py` when the map tools and population file are present, so the order survives rebuilds.

The map page (`public/event-directory/index.html`, Leaflet, OpenStreetMap tiles) colours ~250 km² hexagons by places per 100,000 people, number of places or population, filtered by family, event type or category; shows underserved hexagons for a chosen trade; draws district boundaries with their figures; and, zoomed in, loads the places of the districts in view with name, category, phone, website, rating and sources. The search box finds states, districts and (in loaded districts) places. Its data (`public/event-directory/data/`) is generated and ignored by Git. The Next.js app serves the same page at `/event-directory/` when it is running.

Distances are straight lines, not travel times, and a place counts only if a source lists it, so "far from a caterer" can mean "no caterer is listed".

## Limits

- Listings are what the sources publish. They are not verified, not a census, and may be closed or duplicated in ways the merge rules miss.
- `match_basis=name` rows were matched on the name alone (for example "Sai Tent House" filed as shopping); check them before use.
- District names from boundaries and from the iGOD list do not always match, so a few gaps are false alarms; the extra searches just return places already known.
- Contact details are only what a business lists publicly; nothing is inferred.
- Google Maps collection is subject to Google's terms of service. Keep that data for local research.

## Tests

`python3 scripts/event-directory/test_event_directory.py` runs the whole pipeline, and the geospatial layer when `h3`, `numpy` and `scipy` are installed, offline on small fixtures.
