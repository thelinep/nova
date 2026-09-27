# Brahmini Knowledge Collector

Local-first Next.js workspace for two related workflows:

- collecting Indian business records by district; and
- capturing reusable knowledge from public web pages, URL batches, numbered URL templates, and pasted text.

The application stores its local state in SQLite (`data.db`). It is intended for local development and has no authentication, multi-user isolation, or hosted operational deployment claim.

## Security model

This is a local-first, single-user tool with no authentication or
multi-user isolation, by design. That design only holds if the process
stays unreachable from other machines:

- `npm run dev` and `npm run start` bind to `127.0.0.1` only (see
  `package.json`). Do not override this with `-H 0.0.0.0` or put the
  process behind a tunnel/reverse proxy unless you add real
  authentication first.
- Every API route additionally checks that the request's `Host` header
  is `localhost`/`127.0.0.1`/`[::1]` (`lib/local-only.ts`). This header
  is client-supplied and therefore forgeable by any client that *can*
  reach the process -- it is defense-in-depth, not the actual boundary.
  The loopback bind above is what actually keeps other machines out.

## Data submodule

Location data and validation screenshots live in a separate repository, [brahmini-data](https://github.com/thelinep/brahmini-data), mounted as a git submodule at `data/tlps`. Clone with `git clone --recurse-submodules`, or run `git submodule update --init` in an existing clone. The generated `data/tlps/catalog.db` is rebuilt with `npm run locations:import` and is never committed.

## Start locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The business collector links to the knowledge workspace at [/knowledge](http://localhost:3000/knowledge).

Required runtime configuration belongs in `.env.local` and must not be committed. Current options include:

```dotenv
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3
USE_OLLAMA=false
CONCURRENCY=5
RETRY_ATTEMPTS=3
RETRY_DELAY=2000
```

## Knowledge Collector

The `/knowledge` workspace supports these collection inputs:

| Tool | Input | Bound |
|---|---|---|
| Web page | One public HTTP(S) page | 2 MB text response, 15-second timeout |
| URL list | One public URL per line | 50 URLs per request |
| URL pattern | Template containing `{n}`, such as `https://example.org/page/{n}` | 50 expanded URLs; template is saved locally |
| Paste text | Title plus source text | 2 MB text |

Captured sources are stored in `knowledge_sources`; numbered templates are stored in `knowledge_patterns`. The collector preserves readable text and provenance. It does **not** infer facts that a source does not publish.

### Safety boundaries

- HTTP(S) only; URLs with embedded credentials are rejected.
- Literal private/local addresses and hostnames that resolve to private/local addresses are rejected.
- Redirects are disabled.
- Only HTML, plain text, JSON, and XML response types are accepted.
- Each source is bounded by size and timeout limits.

These controls reduce accidental internal-network fetches. They do not grant permission to collect a site: respect source terms, robots guidance, API conditions, applicable privacy rules, and rate limits.

## Postal and post-office data

`lib/post-office.ts` defines a normalized contract for postal-office records:

```ts
{
  source_id, name, country_code, postal_code, address,
  latitude, longitude, contact_person, source_url
}
```

The contract accepts country-specific aliases such as `pincode`, `postcode`, and `zip_code`, requires a two-letter ISO country code and a source URL, and keeps `contact_person` `null` when a source does not publish one. It rejects malformed coordinates and duplicate source IDs within a batch.

The included fixtures exercise India, UK, Brazil, Japan, and US record shapes. They are a schema/normalization test, not proof that every post office worldwide has been collected. A real global run needs approved sources, explicit licensing/redistribution rights, country-level coverage targets, freshness cadence, and an auditable import report.

## Validation

```bash
npm test -- --runInBand
npm run test:e2e
npm run build
```

- Jest covers routes, page behavior, collection URL guards, jobs, Ollama behavior, and postal-record normalization.
- Playwright covers browser journeys with API interception; it does not call Google Maps or external knowledge sources.
- `npm run build` checks production compilation and TypeScript validation.

## Project layout

```text
app/                       Next.js pages and API routes
app/knowledge/             Knowledge Collector interface
app/api/knowledge/         Collection, saved-pattern, and source APIs
lib/db.ts                  SQLite schema and connection
lib/knowledge.ts           Public-source capture, URL guards, and persistence
lib/post-office.ts         Postal-office normalization contract
__tests__/                 Jest tests
e2e/                       Playwright browser tests
```

## Current business-scraper status

`scrapeDistrict()` (`lib/scraper.ts`, wired up through `POST /api/start-scrape`) drives a headless browser against Google Maps search results, extracts each listing's name, address, phone, rating, review count, website, and coordinates, and persists the result into `scraped_data` and `refined_data`. The DOM-parsing step lives in `lib/scraper-extract.ts` and is covered by fixture tests (`__tests__/scraper-extract.test.ts`) run against saved HTML shapes, so regressions in the parsing logic itself should show up in `npm test`.

What that coverage does *not* give you: the selectors are tied to Google Maps' current markup and will silently under-collect (or return nothing) if that markup changes -- the fixture tests catch regressions in the parsing logic, not drift in the live page, and nothing currently alerts you when a run comes back empty because of the latter. There's also no rate limiting beyond per-district retries, and scraping Google Maps at all may be subject to Google's terms of service -- review those before running this beyond local, personal-scale use. Treat a completed job's result count as "what the current selectors found on that run," not as an independently verified census of businesses in that district.

## Event directory

`scripts/event-directory/` builds a directory of event venues and vendors (24 categories) country by country, India first, from Overture Maps and OpenStreetMap plus the Google Maps collectors' own results, and can fill India's district gaps from Google Maps. See [docs/EVENT-DIRECTORY.md](docs/EVENT-DIRECTORY.md). Double-click `Build event directory.command` in the repository root to run it.

## Supervised district collection

`scripts/collect-event-planners.cjs` (the standalone all-district event-planner collector, separate from the API-driven scraper above) halts on the *first* error or Google access-challenge it hits during a run rather than skipping past it -- by design, so nothing bypasses a real block silently. That makes a full 784-district pass tedious to babysit by hand, so `scripts/collection-supervisor.cjs` wraps it:

- **Auto-restart with backoff.** Any recoverable halt (a single district failing, a transient crash) gets the collector relaunched after 30s/60s/120s/300s backoff, up to 20 attempts, picking up exactly where the SQLite task table left off.
- **Never bypasses a Google access challenge.** If the pause reason mentions an access challenge or consent wall, the supervisor stops for good and asks for manual review -- it will not keep retrying into that.
- **Refuses to run on a near-full disk.** Checks free space before every (re)start and stops immediately under 1 GB free, rather than repeating the `ENOSPC` crash that ended the last run.
- **One retry pass for failed districts.** Once the main pass has nothing left `pending`, if any districts ended up `failed` along the way, it retries them once with `--retry-failed` before declaring the run finished.
- **Notifications.** macOS Notification Center banners plus a running log at `data/event-planners/supervisor.log`, firing on: 25/50/75/100% progress thresholds, each Indian state finishing all its districts, any halt, and final completion. First-run baseline (whatever's already true before you start supervising) is recorded silently so you don't get a burst of stale alerts.

Run it from `india-scraper-next/`:

```
npm run collect:supervised
```

State that survives a supervisor restart (which milestones have already fired) lives in `data/event-planners/supervisor-state.json`, gitignored alongside the log.
