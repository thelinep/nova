# Helpers and scheduler

Open `/helpers` to create a named local AI helper. Choose conversation or search-draft mode, instructions, model and category. Run manually or repeat every hour, six hours, 24 hours or seven days. The first scheduled time is entered in the browser's local timezone and stored in UTC.

Start the persistent worker from this application directory with `npm run scheduler`. Keep the computer awake, Ollama running and the worker terminal open. The page may be closed. This is a local worker, not an operating-system wake timer. Schedules survive restarts; missed repeats are combined into one run, not replayed in a burst. Resuming schedules sets the next run one interval ahead. Pausing a schedule stops future scheduling; it does not interrupt a running answer. Waiting tasks can be cancelled individually.

The worker claims one task at a time transactionally. A second worker cannot claim the same task. Runs store a snapshot of instructions and model. Answers are saved into a new categorized conversation with a source link in task history. Failed runs pause the helper; review the error before resuming. Interrupted runs older than five minutes become failures and require review rather than silently repeating inference.

Helpers cannot browse or execute collection. Query helpers create drafts that users review and save through the existing Search designer. They do not automatically publish claims, collect businesses, or change district coverage.

Data: `data/maataa/helpers.db` and `data/maataa/conversations.db`, both ignored by Git. Test overrides: `MAATAA_HELPERS_DB` and `MAATAA_DB_PATH`. API access is local-only with same-origin writes.

Validation: `node --test tests/helpers.test.cjs tests/maataa.test.cjs` (6 tests); existing Jest suite (119 tests); production build; Playwright helper creation/manual queue at mobile width with no horizontal overflow or page errors. Local worker inference was tested separately using temporary databases.
