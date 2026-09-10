# Unified roadmap dashboard

Open `/roadmap` for a live, plain-language view of Brahmini's delivery and operating state. The page refreshes every ten seconds and combines four bounded evidence layers:

- district collection counts and last recorded runner state;
- local Maataa conversation and publication counts;
- helper, scheduler and run status;
- committed feature milestones with links to their working surface and allowlisted evidence document.

The dashboard reads existing SQLite stores. It does not launch collection, inference or scheduled tasks. If one store cannot be read, that section reports `Unavailable`; missing state is not converted to zero. “Complete” describes the named local feature and its recorded checks, not deployment or production approval. Source-listed businesses remain unverified for operating status and district membership.

The API is available at `/api/roadmap` only on loopback hosts. Evidence links use `/api/roadmap/evidence/[name]`, which serves five explicitly allowlisted Markdown documents as read-only text. Unknown documents return 404 and non-loopback hosts return 403.

## Validation — 2026-09-11

- Roadmap derivation, truth-label and helper-state tests: 3 passed.
- Combined Maataa, helper and roadmap Node tests: 9 passed.
- Existing Jest regression suite: 16 suites and 119 tests passed. Existing React `act(...)` warnings remain in `__tests__/page.test.tsx`; the suite exits successfully.
- Isolated Next.js production build passed with `/roadmap`, `/api/roadmap` and `/api/roadmap/evidence/[name]` included.
- Playwright verified the live metrics, one evidence link, desktop rendering at 1440 px and mobile rendering at 390 px. No page errors or horizontal mobile overflow were observed.
- Local boundary checks: non-loopback Host returned 403, unknown evidence returned 404, allowlisted evidence returned 200.

Screenshots are stored in `docs/roadmap-validation/`.
