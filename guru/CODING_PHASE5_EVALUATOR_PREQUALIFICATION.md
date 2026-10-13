# Evaluator Synthetic Prequalification Harness

This document describes a repeatable evidence tool for Guru's existing Docker
evaluator. It does **not** qualify the current backend, enable candidate-code
evaluation, or connect the evaluator to `tests_pass`, corpus admission, or the
quality audit.

## CLI contract

Run from the `guru/` package root:

```text
python -m guru.evaluator_qualification_cli run \
  --endpoint unix:///absolute/path/to/docker.sock \
  --image python@sha256:<64-hex-digest> \
  --output /private/path/evaluator-prequalification.json

python -m guru.evaluator_qualification_cli verify \
  --report /private/path/evaluator-prequalification.json
```

The `run` command requires an explicit local Unix socket and an image pinned by
SHA-256. No image is currently approved (`APPROVED_PROBE_IMAGE_REF` is unset),
so the command emits unavailable live probes and does not contact Docker. A
reviewed code change must pin an independently reviewed image digest before any
probe image can execute. Until then, every report includes
`probe_image_not_independently_reviewed` and remains non-authoritative. If
enabled after that gate, it sends only package-owned, fixed synthetic probe IDs and constants
to the runtime. It accepts no candidate source, task, corpus item, test suite,
approval, worker attestation, or reviewer input. The CLI has no promotion
command. It stores canonical report metadata and bounded output lengths and
digests; it does not store probe source or raw stdout/stderr.

The output path's parent directory must already exist. The report is written
with owner-only permissions using an atomic replace. `run` returns status 2
after writing because the report cannot qualify a backend by itself. `verify` checks canonical
JSON, duplicate keys, schema, and the report digest. A successful `verify`
means only that the report is intact.

## Evidence and states

`guru.schemas.evaluator_prequalification` defines a strict, ordered probe set,
raw-output-free probe records, the prequalification report, an externally
controlled disposable-worker attestation, an independent-review record, and
a separate promotion decision. `guru.evaluator_prequalification` implements
canonical digests, atomic report persistence/replay, the fixed probe runner,
and a fail-closed promotion candidate verifier. The runner overrides any
image-configured entrypoint with `/usr/local/bin/python`, and its policy digest
binds this fixed executable path.

The report has one of two states:

- `blocked`: an attempted probe failed or cleanup could not be confirmed.
- `prequalification`: no attempted probe failed, but some required probes or
  external qualification evidence remain unavailable.

The current verifier **cannot** return `qualified`: Guru has no authenticated
worker/reviewer trust store or privileged composition root. Plain record
digests and caller-provided values are not trust anchors. The verifier always
adds `authenticated_trust_root_unavailable`, even when supplied synthetic
records are internally consistent. A future composition root must authenticate
the worker attestation and independent review, then bind the exact Linux
disposable VM/profile/reset policy, destroy-and-recreate receipts, report,
config, image, probe set and worker digests. The CLI cannot create or supply
that trust. Missing, stale, mismatched, rejected, or exception-bearing
attestation/review leaves the candidate at `prequalification` or `blocked`.

The fixed set covers effective container controls, network/host visibility,
resource limits, output and wall-clock limits, fresh-container cleanup,
cancellation, runner-crash reaping, daemon restart, host restart/reset, a full
adversarial acceptance suite, synthetic process exit outcomes, actual case-test
pass/fail mapping, evidence replay integrity, and runtime-policy freezing. The
current local runner implements only a subset. Worker lifecycle, cancellation,
process/daemon/host restart, the full adversarial matrix, actual case-test
mapping, and independent lock review are recorded as `unavailable`; missing
probes prevent promotion.

The synthetic success and failure probes exercise only fixed process exit
codes. They are not application test suites and do not establish the quality
gate's `tests_pass` result.

## Current backend limitation

The previously recorded real-container probes used Docker Desktop's persistent
LinuxKit VM on macOS. That workstation-managed VM does not meet the disposable
Linux worker/VM requirement. Its results remain prequalification evidence.
This implementation does not start Docker or execute probes during tests; its
focused tests use a fake evaluator adapter. No backend, host-restart, daemon-
restart, or real adversarial isolation action was exercised while implementing
this harness.

The existing case runner continues to require its unavailable trusted rights
and evaluator providers. This feature adds no provider, does not make an
unqualified evaluator usable for task data, and does not establish corpus
rights or model capability.
