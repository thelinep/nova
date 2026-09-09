# Event planner collection

Run from `india-scraper-next`:

```sh
node scripts/collect-event-planners.cjs
```

The collector resumes pending searches from `data/event-planners/collection.db`. A PID lock prevents concurrent runners. Create `data/event-planners/PAUSE` to stop after the current district, then remove it before resuming. SIGINT and SIGTERM also checkpoint after the current search. `--retry-failed` retries failed searches; `--export-only` regenerates exports while no runner is active.

The frozen `districts.json` contains 784 entries from 36 state/UT pages in the Government of India iGOD district directory, captured September 9, 2026. Each state page's advertised total was reconciled with pagination. This is a directory coverage frame, not a claim that it is the latest LGD administrative register. Do not regenerate the manifest during a collection: its SHA-256 is bound to the database.

Plain Puppeteer reads public Google Maps search cards sequentially using locally installed Google Chrome. HTTP 403/429, unusual traffic, or consent gates stop the run without bypass. Each query records its status, timestamps, source URL, and original observations. A limited-view or exhausted visible list is not proof of exhaustive business coverage. District associations mean a search found a listing, not verified district membership.

`/event-planners` shows searchable results and progress. `/api/event-planners?mode=summary` exposes current counts. CSV contains exact source-category matches for Event planner, Event management company, Wedding planner, or Party planner. JSON contains these records plus `otherSearchCandidates`, coverage, and discovery associations. Raw observations remain in SQLite. Public phone numbers and websites are source-listed and unverified; no personal contacts are inferred.

Live exports, locks, and the database remain local and are ignored by Git. They are refreshed atomically after each district. A runner process must remain alive for collection to continue; no scheduler is installed.

Validation: eight focused Jest tests passed, including category relevance, place deduplication, pagination bounds, and per-district observations.
