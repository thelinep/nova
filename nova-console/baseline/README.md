# L1 Baseline

Two frozen reference points, one per track. Do not merge them in this phase.

## l1-browser-service-readable

- Branch: `codex/browser-service-readable`
- Contents: readable browser service (420 lines), SQLite browser tables,
  11 validated `/browser/*` routes, `playwright.browser.config.js`,
  12-test Playwright suite.
- Tests: main 86/86, browser 12/12.

## l1-nova-model-qualification

- Branch: `codex/nova-model-qualification`
- Contents: hardening slice (governed background jobs, artifact governance,
  encrypted connector secrets, reviewed GitHub PR flow, fail-closed release
  gate).
- Tests: main 86/86.
- Browser tables/routes/tests are not integrated here.

## Verification

    git rev-parse <branch>                # vs commit in JSON
    git archive <branch> | shasum -a 256  # vs tree_sha256 in JSON

## Rollback

    git checkout l1-browser-service-readable
    git checkout l1-nova-model-qualification

## Next phases

P1 durable jobs · P2 policy engine · P3 auto-rollback · P4 budgets+kill switch
· P5 neuron-factory autonomy · P6 workspace-patch autonomy · P7 L2 certification
