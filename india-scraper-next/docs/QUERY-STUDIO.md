# Query studio

Open `/event-planners/studio` to design and test district queries. Templates require `{district}` and `{state}`. Saving creates an immutable method ID and UTC creation timestamp in `query_methods`. Tests use plain Puppeteer against Google Maps and save the rendered query, method ID, timestamps, status, candidate count, and raw records in `query_history`. Tests remain separate from collection coverage.

The migration snapshots each available historical task outcome before retry. Earlier overwritten attempts cannot be reconstructed. Original method registration time is the time it was recorded in the studio; historical attempt times retain their original values. New terminal attempts are retained independently by district and attempt number. Running and pending tasks are not archived as final outcomes.

Succeeded (source-limited) means `limited_view`, `visible_list_exhausted`, or `no_results`; it does not imply complete business coverage. Partial and failed outcomes remain distinct. The collector's `--retry-failed` option preserves successful tasks. Browser errors now pause the runner and leave remaining districts pending instead of failing the entire queue against a detached browser frame.

Methods saved in the studio are test versions. The full district collection continues to use its original frozen query definition. No method edit silently changes completed queries or the coverage frame.

Validation includes immutable retry history, template validation, existing collector tests, a production build, and live browser save/test verification. Collection data is local SQLite, excluded from Git.
