# Guru-Code Evaluator: Real-Container Prequalification

Date: 2026-10-05
Result: **container controls passed; full evaluator security qualification remains open**

## Scope

This run exercised the existing `guru.code_evaluator.evaluate` implementation
against synthetic adversarial payloads in actual Docker containers. It did not
run dataset rows, generated proposals, or a coding benchmark. Teacher/data
rights were not changed by this run and remain a separate pending gate.

## Backend and immutable image

- Host: Docker Desktop on macOS; Docker Engine 28.5.1.
- Worker VM: Docker Desktop LinuxKit, kernel 6.10.14, `aarch64`, cgroup v2.
- Image: `python@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d`.
- Docker daemon reported the built-in seccomp profile.
- The Docker Desktop Linux VM is persistent and workstation-managed. It is not
  the disposable Linux worker/VM required by the release gate.

The daemon had previously failed with storage/metadata I/O errors when the Mac
data volume was nearly full. After available host storage recovered, Docker
Desktop was started again. The daemon came up cleanly, the old test container
was absent, and the following qualification probes completed without a repeat
of the metadata error.

## Effective container configuration

A live container was inspected while its synthetic process was running:

| Control | Observed value |
| --- | --- |
| Network | `none` |
| User | `65534:65534` |
| Root filesystem | Read-only |
| Mounts | None |
| Linux capabilities | `ALL` dropped |
| Privilege escalation | `no-new-privileges` |
| Memory and swap | 128 MiB memory; swap limit equals memory limit |
| CPU | 0.5 CPU (`500000000` NanoCPUs) |
| Process count | 16 |
| Scratch | `/tmp` tmpfs, 2 MiB, `noexec,nosuid,nodev` |

In-container observations also showed UID/GID 65534, `NoNewPrivs: 1`,
`Seccomp: 2`, zero effective capabilities, a read-only root, no visible Mac
home path, no visible Docker socket, and cgroup limits matching the policy.
Connections to `1.1.1.1:53` failed and `host.docker.internal` did not resolve.
These are bounded probes, not exhaustive proof against every host or local
service route.

## Probe results

Each row used a fresh container. `container_removed=true` was returned in every
normal evaluator result.

| Probe | Configuration / adversarial action | Observed result |
| --- | --- | --- |
| Baseline | Inspect identity, capabilities, cgroups, root write access, visible host paths/socket, and attempt two outbound connections | UID/GID 65534; seccomp active; no effective caps; root write denied; no Mac home or Docker socket; outbound probes failed; container removed |
| CPU | 0.5 CPU; run a busy loop; inspect cgroup `cpu.max` | `50000 100000`; container removed |
| PID | PID limit 8; fork repeatedly | Seven child processes created, then `fork` failed with errno 11; container removed |
| Scratch | 1 MiB tmpfs; attempt a 2 MiB write | ENOSPC errno 28 at exactly 1,048,576 bytes; container removed |
| Output | 1,024-byte combined output cap; print 10,000 bytes | Evaluator stopped the attached process (`exit_code=-9`), reported `output_limited=true`; container removed |
| Wall time | 1-second timeout; sleep 4 seconds | `timed_out=true`, `exit_code=-9`; container removed |
| Memory | 96 MiB memory/swap limit; request a 256 MiB allocation | Process terminated with `exit_code=137`; container removed. This run did not separately capture Docker's `OOMKilled` field. |
| Cancellation | Send SIGINT to the evaluator process while its container sleeps | Evaluator unwound through cleanup, surfaced `KeyboardInterrupt`, and returned; container removed |
| Effective config | Inspect a live half-CPU container with Docker | Observed policy values above; evaluation then completed and removed it |

After cancellation and again after live inspection, `docker ps -a --no-trunc`
showed no containers. The final inspection run also ended with zero containers.

## Follow-up implementation status (2026-10-12)

The October 5 probe results above are historical. Subsequent changes added a
per-installation owner token, serialized evaluator lifecycle lock, managed
container labels, and startup reaping of abandoned evaluator containers. The
case runner also produces a versioned, digest-chained evidence record with
case ID, command, input identities, output digests and lengths, configured
limits, outcome, and cleanup status. The evidence schema and append-only log
helpers are implemented; normal production composition does not yet append
case evidence because there is no qualified evaluator/provider integration.

Focused evaluator and case-runner suites passed 43 tests on 2026-10-12, and the
full Guru suite passed 328 tests with one skipped. These are local synthetic
contract tests. Startup reaping is tested with mocked Docker inventory and
removal; a process-death test confirms lock release but stubs the reaper. No
real orphan cleanup, daemon/host restart recovery, disposable Linux worker, or
candidate code execution was performed. The implementation changes therefore
do not change the qualification result below.

## Qualification boundary

The tested Docker controls passed on this backend. This is **real-container
prequalification**, not release qualification. The Phase 5 acceptance gate
remains blocked because:

1. The Docker Desktop VM is persistent, not an approved disposable worker/VM.
2. Docker daemon or host restart recovery has not been qualified on a real
   backend. The evaluator now implements startup reaping under a serialized
   per-installation lock, but the reaper is covered only by mocked Docker
   inventory/removal tests; no real orphan cleanup or restart recovery run has
   occurred.
3. Isolation checks against every worker-local service, another concurrent
   task, and IPv6 routes have not been performed.
4. A digest-chained per-case evidence schema and append helper now exist, but
   production case execution is not wired to a qualified provider that
   durably appends those records. Detailed resource-limit event metadata is
   also not captured.
5. The memory probe returned 137, but this run did not separately record the
   daemon's OOM event metadata.

Until these gaps are closed on an approved disposable Linux backend, do not
run candidate corpus rows or generated proposals through this evaluator and do
not treat this result as code-correctness evidence. The independent teacher
rights review remains pending; this evaluator run neither depended on nor
approved training data.
