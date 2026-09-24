# Collector production-hardening evidence

Recorded 2026-09-15 from the canonical local `india-scraper-next` database and NOVA connector.

## Real-record schema audit

- Database: `india-scraper-next/data/event-planners/collection.db`
- Query-history rows: 1,544
- Rows retaining `records_json`: 4
- Raw-evidence rows valid against schema version 1: 4/4
- Validation failures: 0
- Historical limitation: 1,540 legacy query rows do not retain raw records and cannot be reconstructed as raw evidence.
- Current database status snapshot: 756 failed, 749 source-limited, 39 visible-list-exhausted; this is observed coverage, not exhaustive source coverage.

The audit validates query ID, task and method IDs, rendered query, source URL, source timestamps, terminal status, limitation, record count, raw record shape, source provenance, verification status, district-association label, and Google Maps listing URL.

## Runtime persistence and recovery

- The runner emits one versioned evidence envelope per query, sourced from the persisted `query_history` timestamps and raw records.
- NOVA rejects missing fields, unsupported schema versions, unapproved methods, invalid source URLs, reversed timestamps, unknown statuses, count drift, and invalid raw-record provenance.
- Each query envelope has an idempotent evidence ID derived from run ID and query-history ID.
- Each raw listing is retained as a query-specific observation. A separate stable listing key supports deduplication without overwriting observations from later queries.
- Paused and challenge-stopped runs require fresh approval before resuming.
- Resume starts from persisted query-history checkpoints; source-observation terminal states are skipped while failed queries remain eligible for retry.

## Challenge-stop drills

- The real collector received a simulated HTTP 429 response and returned `blocked`, zero raw records, and the limitation `HTTP 429` without attempting extraction.
- NOVA classifies blocked evidence or challenge/CAPTCHA diagnostics as `challenge-stopped`, including when a child exits with code zero.
- Invalid evidence terminates ingestion and leaves the run paused for review.
- No challenge bypass or live source request was used for these drills.

## Validation

- NOVA backend: 50/50 tests passed.
- India Scraper Jest: 133/133 tests passed.
- Focused NOVA collector tests: 8/8 passed.
- Focused runner schema, checkpoint, and challenge tests: 4/4 passed.
- Real database audit: 4/4 retained raw-evidence rows valid.
