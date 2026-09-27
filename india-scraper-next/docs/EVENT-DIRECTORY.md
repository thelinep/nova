# Event directory: venues and vendors, country by country

A directory of event venues and vendors, built India first and extendable to any country with the same method. Everything stays local in `data/event-directory/` (ignored by Git).

## What counts

`scripts/event-directory/taxonomy.json` defines 58 categories in 13 families: Venue & location · Planning & production · Design & décor · Technical production · Food & hospitality · Talent & entertainment · Photo, film & broadcast · Guest experience · Travel & logistics · Safety, permits & compliance · Branding & fabrication · Digital experience · Personal style & beauty. Every place carries its `family` and `primary_category`; `summary-<CC>.md` has a state × family table.

Broad categories (listed under `generic`, such as Overture's catch-all "party and event planning" or "printing service") give way to a specific name: "… Mangal Karyalay" becomes a banquet hall, "… Flex Printing" signage.

Each category has a regex for source categories/tags, one for names (with Indian terms such as *kalyana mandapam*, *mangal karyalay*, *halwai*, *shamiana*), a Google search phrase and a per-district "gap" threshold. Edit the file to tune it; rebuild to apply.

## Sources

| Source | Stage | Licence | Notes |
|---|---|---|---|
| Overture Maps Places | `overture` | CDLA-Permissive-2.0 (ODbL where from OSM) | Read directly from Overture's public S3 bucket with DuckDB, filtered to the country's box and address country. Also fetches district (county) and state boundaries. |
| OpenStreetMap | `osm` | ODbL-1.0 | Overpass API, one state at a time, resumable (`raw/osm-<CC>.progress.json`). |
| Google Maps (own collectors) | `google` | Google's terms | Imports the event-planner survey (`data/event-planners/collection.db`) and gap runs (`data/event-directory/google-IN.db`). India only. |

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

Double-click **Fill event directory gaps from Google.command**. It installs the app's packages once (using your Google Chrome), searches up to 300 gaps per run, emptiest first, with the survey's own search code, then rebuilds. A Google access challenge, consent page or HTTP 403/429 stops the run; it stays stopped until you have checked Google Maps yourself and create `data/event-directory/REVIEWED`. Create `data/event-directory/PAUSE` to stop after the current search. A full pass over every gap is thousands of searches and takes days of runs.

## Limits

- Listings are what the sources publish. They are not verified, not a census, and may be closed or duplicated in ways the merge rules miss.
- `match_basis=name` rows were matched on the name alone (for example "Sai Tent House" filed as shopping); check them before use.
- District names from boundaries and from the iGOD list do not always match, so a few gaps are false alarms; the extra searches just return places already known.
- Contact details are only what a business lists publicly; nothing is inferred.
- Google Maps collection is subject to Google's terms of service. Keep that data for local research.

## Tests

`python3 scripts/event-directory/test_event_directory.py` runs the whole pipeline offline on small fixtures.
