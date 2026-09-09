# TLPS absorption into Brahmini

This branch adds a local location knowledge catalogue alongside the existing business and knowledge collectors. The location importer does not open the collector's `data.db`, migrate existing records, start scrapers, or establish production readiness. See [validation report](TLPS-VALIDATION.md) for the initial legacy-test database incident.

## Run

From `india-scraper-next`:

```sh
npm run locations:import
npm run locations:validate
npm run dev
```

Open `/locations` for the native catalogue or `/locations/campaign` for the absorbed campaign explorer. Both are linked from the business collector. The native catalogue provides full-text prefix search, collection/category/region filters, paginated results, a local Leaflet map, map-boundary search, source inspection, and JSON export of the current page. Map markers represent only the current page, at most 500 records. Search matches all whitespace-separated terms across name, category, state, city and district. Cross-source duplicates are retained, with IDs namespaced by corpus and dataset.

The campaign explorer preserves the supplied map, radar, clustering, category controls, graph, discovery queue, browser-local planning edits and export flows. It is intentionally hosted as an adapted standalone HTML view inside a Brahmini route, rather than rewritten into React. It loads local snapshot routes and vendored map code. Browser edits use a new `brahmini-tlps-campaign-v1` localStorage key and are not written into the shared read-only catalogue. Source-imported campaign records and known seed IDs are read-only; manual planning copies are distinct. Only manual records are persisted, avoiding the inherited 11 MB localStorage write. JSON import merges manual records while preserving source rows.

## Data and provenance

- Campaign: **55,731** records, including **7,280 planning anchors**, rather than 55,731 approved venues.
- Global: **708,222** GeoNames records in five groups, snapshot accessed **2026-07-23**.
- Combined: **763,953 source records**, with **zero execution-ready sites**.
- `data/tlps/manifest.json` records source paths, compressed checksums, uncompressed campaign checksums, snapshot counts and source-workspace provenance. The source root had no Git commits; the nested Location OS checkout had uncommitted work. This is a versioned snapshot absorption, not a claim of a clean upstream release.
- Campaign JSON, original HTML and README are stored as lossless gzip files. GeoNames gzip files, manifest, clusters and README are preserved byte-for-byte.
- GeoNames attribution: GeoNames (`www.geonames.org`), **CC BY 4.0**. Transport data includes OpenStreetMap contributors, **ODbL**. Other original source URLs, licenses and collection limitations remain in each record and the retained campaign README. Public redistribution rights and refreshed source availability have not been newly verified.
- Partial IOCL coverage remains partial. Census 2011 values are historical. Unresolved district/environmental values remain null. Source listing does not establish operational availability, permissions, safety, commercial terms or field survey.

## Storage and boundaries

`locations:import` verifies all snapshots, constructs a separate `data/tlps/catalog.db` with namespaced records and an FTS5 index, then atomically replaces that derived file only after validation succeeds. Original source records are stored in compressed blocks in the index and restored for inspection/export. A matching manifest causes import to skip rebuilding. The index and its SQLite sidecars are ignored by Git. No existing Brahmini database is opened by the importer. Source files and importer are committed so another checkout can regenerate the index.

`GET /api/locations` accepts `q`, `corpus=campaign|global`, `category`, `state`, `id`, `limit=1..500`, `offset=0..1000000` and `bbox=west,south,east,north`. Crossing the antimeridian is supported. Invalid pagination/bounds return 400; a missing index returns 503 with setup instructions. `mode=summary` returns verified index counts and filter options. SQL is parameterized; search strings are tokenized into quoted FTS terms. No raw database or filesystem path is served. Campaign snapshot routes use a fixed allowlist.

Leaflet 1.9.4 and MarkerCluster 1.5.3 are vendored with their license notices so local map controls do not need a CDN. OpenStreetMap basemap tiles still need internet; the native search and pins can work without tiles. The existing application's local-only, unauthenticated deployment boundary remains applicable.

## Validation

```sh
npm test -- --runInBand
npm run locations:validate
npm run build
npx playwright test
```

The new API/browser checks require `locations:import` first. The focused suite uses real imported records, not mocked catalogue responses. Unit tests separately use small artificial fixtures to test malformed input, pagination, source identity, FTS escaping and antimeridian bounds.

## Rollback

Switch away from `codex/absorb-tlps-locations` after preserving any new work. Pre-existing untracked files are preserved. The importer never opens the collector database. See the validation report for the initial legacy test cleanup incident. The ignored derived catalogue may be retained or removed separately; it is reproducible from committed snapshots. Browser-local campaign edits need a JSON export before intentionally clearing their storage.

The shared SQLite module now uses an in-memory database when `NODE_ENV=test`, preventing existing knowledge-store cleanup tests from deleting persisted operator records. Runtime storage remains unchanged.

For an isolated build and preview, use `BRAHMINI_NEXT_DIST_DIR=.next-tlps npm run build`, then `BRAHMINI_NEXT_DIST_DIR=.next-tlps npm run start -- --hostname 127.0.0.1 --port 3194`. Run `node scripts/capture-tlps.cjs` against that server to refresh the screenshots and build provenance.
