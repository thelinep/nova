# TLPS integration validation — 2026-09-09

Branch: `codex/absorb-tlps-locations` in `/Users/vesahe/Documents/brahmini`.
Base commit: `f5a6e91`.

## Final verified result

- **109 tests pass across 14 Jest suites.** Existing Home component tests still emit React `act(...)` warnings; these are not hidden as a clean warning-free run.
- **11 Playwright browser tests pass.** Eight existing collector tests use their existing mocked service responses. Three new integration tests exercise the real imported location catalogue, native map/search/evidence/export and mobile sizing, and the campaign explorer's radar and persisted manual pin after reload.
- **Next.js optimized build passes**, including type validation, using `BRAHMINI_NEXT_DIST_DIR=.next-tlps`. Test server binds only `127.0.0.1:3194`.
- **19 source-file checksums match.** SQLite integrity and bounded-query checks pass. Index counts: campaign **55,731**; GeoNames **708,222**; total **763,953**; execution ready **0**.
- Derived SQLite catalogue: approximately **299 MiB**. It is ignored by Git and reproducible. The initial 993 MiB per-record-compression index was removed and replaced with block compression.
- Source IDs and complete original record JSON remain inspectable. Compressed campaign assets preserve their uncompressed checksums; global assets are byte-identical to the supplied snapshot.
- Native desktop/mobile and campaign screenshots plus exact build ID are in `tlps-validation/`. These captures demonstrate the observed surfaces, not production deployment or comprehensive workflow certification.

## Bugs resolved during absorption

1. Bounded SQL/FTS search replaces repeated whole-gzip scans. Invalid limits, offsets, corpora and map bounds return 400; the NaN limit bypass is rejected.
2. Only allowlisted campaign snapshot files are served. No workspace static-file server or database download route was imported.
3. Filter controls have explicit accessible names. Search results automatically fit the native map. Source links are limited to HTTP(S).
4. Campaign map assets are vendored. The inherited CARTO basemap showed an API-key warning during browser inspection; the served adapter now uses OpenStreetMap tiles with attribution.
5. Campaign storage persists only manual planning records. The original explorer attempted to save its approximately 11 MB seed into localStorage. Known seed IDs are excluded even when they share the `LOC-` prefix, and imported JSON cannot replace original source rows. The browser regression verifies one saved manual row and 55,732 displayed records after reload; catalogue source counts remain unchanged.
6. Test database isolation prevents the legacy knowledge-store cleanup from opening a persisted database in future runs.

## Initial legacy-test database incident

The first full Jest run used the pre-existing `lib/db.ts`, whose database path was always `process.cwd()/data.db`. The existing `__tests__/knowledge/store.test.ts` cleanup executes `DELETE FROM knowledge_chunks` and `DELETE FROM knowledge_sources`; that cleanup ran against `india-scraper-next/data.db` before the problem was identified. No pre-run database copy was made, so the prior contents of those two tables and whether user records were removed cannot be established. This limitation must not be described as “all collector data untouched.”

Post-incident read-only inspection found zero rows in those two app tables, three `knowledge_seeker_sources` rows, and zero app scraped/refined rows. The separate repository-root `data.db` was not opened by these tests and still contains 63 scraped and 63 refined records; it has no knowledge tables to use for a verified restoration. No speculative restoration was attempted.

`lib/db.ts` now uses `:memory:` under `NODE_ENV=test`. The new `db-isolation.test.ts` verifies that the SQLite main database has no persisted file. Subsequent complete suites pass with that isolation. The TLPS importer never opens either collector database.

## Scope and limitations

This is a local integration, not a deployment or source refresh. GeoNames is the 2026-07-23 snapshot; partial locator coverage, historical census fields, source attribution and unknown verification states remain explicit. Basemap tiles need internet. The native map displays one bounded result page, not the complete world's pins simultaneously. Campaign planning edits stay in browser storage and do not alter the native read-only catalogue. The campaign explorer is an adapted standalone HTML surface, not a React rewrite.

Pre-existing untracked `README.md`, `lib/post-office.ts`, and `__tests__/post-office-collection.test.ts` were preserved and excluded from the integration commits.
