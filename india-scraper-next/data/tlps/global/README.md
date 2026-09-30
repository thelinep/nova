# TLPS Location OS real-pin snapshot v2

This directory contains source-backed geographic point records generated from the GeoNames global gazetteer. It is a discovery snapshot, not proof that a place is currently operational, publicly accessible, commercially available, suitable for production, safe, surveyed or permitted.

## Inventory

- 708,222 coordinate-backed records
- 37 pin categories
- 5 operational map groups
- 10,434 five-degree category clusters
- WGS84 coordinates
- Country, state/province and district/region codes where supplied
- Country profiles on capital records: capital, currency, languages and population

The large record sets are stored as deterministic gzip-compressed NDJSON. `manifest.json` records counts and SHA-256 checksums. `world-clusters.json` supports the interactive world view without rendering hundreds of thousands of DOM nodes.

## Source and attribution

- Authority: GeoNames
- Download: <https://download.geonames.org/export/dump/>
- License: CC BY 4.0
- Required attribution: GeoNames (`www.geonames.org`)
- Snapshot accessed: 2026-07-23

Every record retains its GeoNames identifier and a direct `https://www.geonames.org/{id}` evidence URL.

## Truth boundary

All imported records use `SOURCE_LISTED_DISCOVERY`, `GEONAMES_COORDINATE_UNVERIFIED` and `REQUIRED_FOR_PRODUCTION_USE`. Existing verified records must never be silently overwritten.

Petrol pumps are not represented by a GeoNames retail-fuel feature code. IOCL returned HTTP 403 to automated access during this import, and the public Overpass whole-country query timed out. Media Ant does not expose a documented licensed bulk inventory export in the reviewed public surface. RWA, district-language, soil, botanical-species and zoological-species completeness also require separate authoritative datasets. These lanes remain explicit exclusions in `manifest.json`; no substitute or inferred pins were fabricated.

## Regeneration

Download `allCountries.zip`, `countryInfo.txt`, `admin1CodesASCII.txt`, `admin2Codes.txt` and `featureCodes_en.txt` from the official GeoNames dump, then run:

```sh
pnpm location:pins:import:geonames -- \
  --archive=/path/to/allCountries.zip \
  --countries=/path/to/countryInfo.txt \
  --admin1=/path/to/admin1CodesASCII.txt \
  --admin2=/path/to/admin2Codes.txt \
  --features=/path/to/featureCodes_en.txt \
  --output=data/location-os/seeds/v2 \
  --accessedAt=YYYY-MM-DDT00:00:00.000Z
```
